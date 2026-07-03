import { indexSessionSegmentEmbeddings, listWorkspaces, makeDatabase } from '@saga/db';
import type {
  IndexSessionSegmentEmbeddingsInput,
  SessionEmbeddingGenerator,
  SessionEmbeddingIndexResult,
  WorkspaceSummary,
} from '@saga/db';
import { loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { findProjectRoot, readBindingFile } from './init.js';
import type { WorkspaceBindingFile } from './init.js';
import { formatCommandOutput } from './output.js';
import { recordBlock } from './render.js';
import type { RenderOptions } from './render.js';

const INDEX_FLAGS_WITH_VALUES = new Set([
  'activity',
  'activity-interval',
  'activity-interval-id',
  'limit',
  'raw',
  'raw-record',
  'raw-session-record',
  'raw-session-record-id',
  'session',
  'session-id',
  'workspace',
  'workspace-id',
]);
const INDEX_BOOLEAN_FLAGS = new Set<string>(['all']);

// Fixed batch size for the fill-to-completion loop used by --all. Each batch selects only
// Segments lacking a current embedding (ADR-0039), so successive batches advance until a
// Workspace is fully covered. Not operator-tunable: --all is a completion job, not a
// bounded single run.
const INDEX_ALL_BATCH_SIZE = 1_000;

export type IndexCommandDependencies = {
  cwd?: string | undefined;
  // Fake/local embedding generator for tests. Left undefined in production so
  // indexSessionSegmentEmbeddings resolves the remote generator behind the ADR-0032
  // installation policy gate (never hand it a remote generator here).
  embeddingGenerator?: SessionEmbeddingGenerator | undefined;
  indexEmbeddings?:
    | ((input: IndexSessionSegmentEmbeddingsInput) => Promise<SessionEmbeddingIndexResult>)
    | undefined;
};

export async function runIndexCommand(
  args: readonly string[],
  options: RenderOptions,
  dependencies: IndexCommandDependencies = {},
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: INDEX_BOOLEAN_FLAGS,
    flagsWithValues: INDEX_FLAGS_WITH_VALUES,
  });
  if (parsed.positionals.length > 0) {
    throw new Error(`index received unexpected argument: ${parsed.positionals[0]}`);
  }

  if (parsed.booleans.has('all')) {
    return runIndexAll(parsed.flags, options, dependencies);
  }

  const project = loadBoundProject(dependencies.cwd);
  const input: IndexSessionSegmentEmbeddingsInput = {
    activityIntervalId: firstFlag(parsed.flags, [
      'activity-interval-id',
      'activity-interval',
      'activity',
    ]),
    limit: parsePositiveIntegerFlag(parsed.flags.limit, 'limit'),
    rawSessionRecordId: firstFlag(parsed.flags, [
      'raw-session-record-id',
      'raw-session-record',
      'raw-record',
      'raw',
    ]),
    sessionId: firstFlag(parsed.flags, ['session-id', 'session']),
    workspaceId: workspaceIdFromFlags(parsed.flags, project.binding),
  };

  const result =
    dependencies.indexEmbeddings === undefined
      ? await withDatabase(project.projectRoot, async (service) =>
          Effect.runPromise(
            indexSessionSegmentEmbeddings(service, {
              ...input,
              generator: dependencies.embeddingGenerator,
            }),
          ),
        )
      : await dependencies.indexEmbeddings(input);

  return formatCommandOutput(
    { records: renderIndexResult(result, options), value: result },
    options.format,
  );
}

type WorkspaceFillStatus = SessionEmbeddingIndexResult['status'] | 'failed';

type WorkspaceFillSummary = {
  batches: number;
  error?: string | undefined;
  handle: string;
  indexedCount: number;
  provider?: SessionEmbeddingIndexResult['provider'] | undefined;
  skipped?: SessionEmbeddingIndexResult['skipped'] | undefined;
  status: WorkspaceFillStatus;
  workspaceId: string;
};

type IndexAllResult = {
  failedCount: number;
  totalIndexed: number;
  workspaceCount: number;
  workspaces: WorkspaceFillSummary[];
};

// `saga index --all`: enumerate every Workspace the service knows (from the DB, not a cwd
// binding — a cron has no bound project) and fill each to completion. Idempotent and safe to
// overlap by ADR-0039 (each batch embeds only absent Segments); ADR-0032 policy gating still
// applies per Workspace, surfaced as a skipped status. Each Workspace is isolated: a failure
// (e.g. a transient OpenAI 429 or a DB error) is recorded on that Workspace and the run
// continues to the rest, so one bad Workspace can't starve the others — a cron re-run retries it.
async function runIndexAll(
  flags: Record<string, string>,
  options: RenderOptions,
  dependencies: IndexCommandDependencies,
): Promise<string> {
  rejectScopedFlagsForAll(flags);

  const summaries = await withDatabase(dependencies.cwd ?? process.cwd(), async (service) => {
    const workspaces = await Effect.runPromise(listWorkspaces(service));
    const results: WorkspaceFillSummary[] = [];
    for (const workspace of workspaces) {
      // Sequential on purpose: one shared connection, and bounded, predictable load for a
      // background job rather than a burst across every Workspace at once.
      try {
        results.push(
          await fillWorkspaceEmbeddings(service, workspace, dependencies.embeddingGenerator),
        );
      } catch (error) {
        results.push({
          batches: 0,
          error: error instanceof Error ? error.message : String(error),
          handle: workspace.handle,
          indexedCount: 0,
          status: 'failed',
          workspaceId: workspace.id,
        });
      }
    }
    return results;
  });

  const result: IndexAllResult = {
    failedCount: summaries.filter((summary) => summary.status === 'failed').length,
    totalIndexed: summaries.reduce((sum, summary) => sum + summary.indexedCount, 0),
    workspaceCount: summaries.length,
    workspaces: summaries,
  };
  return formatCommandOutput(
    { records: renderIndexAll(result, options), value: result },
    options.format,
  );
}

function rejectScopedFlagsForAll(flags: Record<string, string>): void {
  const scoped = Object.keys(flags).filter((name) => INDEX_FLAGS_WITH_VALUES.has(name));
  if (scoped.length > 0) {
    throw new Error(
      `--${scoped[0]} cannot be combined with --all; --all indexes every workspace to completion`,
    );
  }
}

async function fillWorkspaceEmbeddings(
  service: Awaited<ReturnType<typeof openDatabase>>,
  workspace: WorkspaceSummary,
  generator: SessionEmbeddingGenerator | undefined,
): Promise<WorkspaceFillSummary> {
  let indexedCount = 0;
  let batches = 0;
  let provider: SessionEmbeddingIndexResult['provider'] | undefined;
  let status: SessionEmbeddingIndexResult['status'] = 'completed';
  let skipped: SessionEmbeddingIndexResult['skipped'] | undefined;

  for (;;) {
    const batch = await Effect.runPromise(
      indexSessionSegmentEmbeddings(service, {
        generator,
        limit: INDEX_ALL_BATCH_SIZE,
        workspaceId: workspace.id,
      }),
    );
    batches += 1;
    indexedCount += batch.indexedCount;
    provider = batch.provider;

    if (batch.status === 'skipped') {
      status = 'skipped';
      skipped = batch.skipped;
      break;
    }
    // Stop when a completed batch embedded nothing — the absent set is exhausted. Keyed on
    // indexedCount (not eligibleCount vs the batch size) so it stays correct no matter how
    // the batch size relates to the indexer's own MAX_LIMIT clamp: a completed batch embeds
    // every eligible row (anti-join → all pending), so indexedCount 0 ⇔ nothing left.
    if (batch.indexedCount === 0) {
      break;
    }
  }

  return {
    batches,
    handle: workspace.handle,
    indexedCount,
    ...(provider === undefined ? {} : { provider }),
    ...(skipped === undefined ? {} : { skipped }),
    status,
    workspaceId: workspace.id,
  };
}

function renderIndexAll(result: IndexAllResult, options: RenderOptions): string {
  const header = recordBlock(
    'Embedding Index — all workspaces',
    [
      { label: 'workspaces', value: String(result.workspaceCount) },
      { label: 'indexed', value: String(result.totalIndexed) },
      { label: 'failed', value: String(result.failedCount) },
    ],
    options,
  );
  const blocks = result.workspaces.map((summary) =>
    recordBlock(
      `workspace ${summary.handle}`,
      [
        { label: 'workspace id', value: summary.workspaceId },
        { label: 'status', value: summary.status },
        { label: 'indexed', value: String(summary.indexedCount) },
        { label: 'batches', value: String(summary.batches) },
        ...(summary.status === 'skipped'
          ? [{ label: 'skip reason', value: summary.skipped?.reason ?? 'unknown' }]
          : []),
        ...(summary.status === 'failed'
          ? [{ label: 'error', value: summary.error ?? 'unknown' }]
          : []),
      ],
      options,
    ),
  );
  return [header, ...blocks].join('\n');
}

function renderIndexResult(result: SessionEmbeddingIndexResult, options: RenderOptions): string {
  const fields = [
    { label: 'workspace', value: result.workspaceId },
    { label: 'status', value: result.status },
    { label: 'provider', value: `${result.provider.id}/${result.provider.model}` },
    { label: 'dimensions', value: String(result.provider.dimensions) },
    { label: 'eligible', value: String(result.eligibleCount) },
    { label: 'indexed', value: String(result.indexedCount) },
    { label: 'existing', value: String(result.existingCount) },
    { label: 'stale', value: String(result.staleCount) },
    { label: 'skipped', value: String(result.skipped.count) },
    {
      label: 'lexical fallback',
      value: `${result.lexicalFallback.state} — ${result.lexicalFallback.detail}`,
    },
  ];
  if (result.status === 'skipped') {
    fields.push(
      { label: 'skip reason', value: result.skipped.reason ?? 'unknown' },
      { label: 'detail', value: result.skipped.detail ?? 'none' },
      { label: 'guidance', value: result.skipped.guidance ?? 'none' },
    );
  }
  return recordBlock('Embedding Index', fields, options);
}

type BoundProject = {
  binding: WorkspaceBindingFile;
  projectRoot: string;
};

function loadBoundProject(cwd: string | undefined): BoundProject {
  const projectRoot = findProjectRoot(cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error('workspace binding is missing; run saga init');
  }
  return { binding, projectRoot };
}

async function withDatabase<T>(
  projectRoot: string,
  runWithService: (service: Awaited<ReturnType<typeof openDatabase>>) => Promise<T>,
): Promise<T> {
  const service = await openDatabase(projectRoot);
  try {
    return await runWithService(service);
  } finally {
    await Effect.runPromise(service.close());
  }
}

async function openDatabase(projectRoot: string) {
  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  return Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
}

type LocalOptions = {
  booleans: Set<string>;
  flags: Record<string, string>;
  positionals: string[];
};

function parseLocalOptions(
  args: readonly string[],
  spec: { booleanFlags: ReadonlySet<string>; flagsWithValues: ReadonlySet<string> },
): LocalOptions {
  const booleans = new Set<string>();
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split('=', 2);
    const name = rawName ?? '';
    if (spec.booleanFlags.has(name)) {
      if (inlineValue !== undefined) {
        throw new Error(`--${name} does not take a value`);
      }
      booleans.add(name);
      continue;
    }
    if (!spec.flagsWithValues.has(name)) {
      throw new Error(`unknown index option: --${name}`);
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined) {
      throw new Error(`--${name} expects a value`);
    }
    flags[name] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return { booleans, flags, positionals };
}

function parsePositiveIntegerFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`--${label} must be a positive integer`);
  }
  return parsed;
}

function workspaceIdFromFlags(
  flags: Record<string, string>,
  binding: WorkspaceBindingFile,
): string {
  return flags['workspace-id'] ?? flags.workspace ?? binding.workspace.id;
}

function firstFlag(flags: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
