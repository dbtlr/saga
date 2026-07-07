import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { extname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { IngestItem, IngestItemResult, IngestSnapshot, RawEvent } from '@saga/api-client';
import { rawEventFromClaudeHook, rawEventFromCodexHook } from '@saga/collectors';
import type { HarnessHookInput, HarnessSource } from '@saga/collectors';
import { findProjectRoot } from '@saga/runtime';

import { readBindingFile } from './binding.js';
import { parseLocalOptions } from './command-args.js';
import { resolveClient, resolveWorkspaceId } from './command-context.js';
import type { ClientCommandContext } from './command-context.js';
import { formatCommandOutput } from './output.js';
import { recordBlock } from './render.js';
import type { RenderOptions } from './render.js';

// The INGEST client commands (SGA-239 slice 3). These run over @saga/api-client's
// POST /v1/ingest and GET /v1/events instead of the local db path in
// apps/cli/src/ingest.ts. The field-computation that apps/cli feeds into a
// @saga/db RawSessionImportInput is ported here to emit a @saga/contracts
// IngestSnapshot instead; the service reconstructs the import input server-side
// (buildStoreInput) and the extraction job derives it asynchronously. The
// snapshot the client builds is one the extraction job derives identically to the
// synchronous CLI path (proven by apps/cli/src/client-ingest.postgres.test.ts).

// The local-machine binding the hook capture path needs beyond the workspace id:
// the harness source binding and the host identity the snapshot carries. Resolved
// from the on-disk binding file in normal use; injected directly in tests.
export type HookCaptureBinding = {
  host: { id: string; label?: string | undefined };
  sourceBindingId: string;
  workspaceId: string;
};

// The result of a hook capture. Reflects the service's per-item ack
// (IngestItemResult) rather than the db path's inserted/unchanged/skipped
// operation (ADR-0047: the ack means STORED, not derived).
export type HookIngestResult = {
  accepted: boolean;
  ackStatus?: IngestItemResult['status'] | undefined;
  code?: string | undefined;
  error?: string | undefined;
  mode: 'captured' | 'skipped';
  rawEventId?: string | undefined;
  rawSessionRecordId?: string | undefined;
  source: HarnessSource;
};

export type CodexHookIngestResult = HookIngestResult & { source: 'codex' };
export type ClaudeHookIngestResult = HookIngestResult & { source: 'claude' };

export type IngestHookOptions = {
  // DI seam for tests: skip on-disk binding resolution.
  binding?: HookCaptureBinding | undefined;
  // DI seam for tests: fully override the build+POST capture step.
  capture?: ((input: HarnessHookInput) => Promise<HookIngestResult>) | undefined;
  inputPath?: string | undefined;
  // Clock for the raw-event occurredAt (deterministic in tests).
  now?: Date | undefined;
  stdin?: string | undefined;
};

export async function runIngestCommand(
  args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext = {},
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === 'claude-hook') {
    return ingestHook('claude', options, context, { inputPath: args[1] });
  }
  if (subcommand === 'codex-hook') {
    return ingestHook('codex', options, context, { inputPath: args[1] });
  }
  if (subcommand === 'recent') {
    return inspectRecentRawEvents(args.slice(1), options, context);
  }
  throw new Error(`ingest ${subcommand ?? ''} is not implemented yet`.trim());
}

export async function ingestClaudeHook(
  options: RenderOptions,
  context: ClientCommandContext = {},
  input: IngestHookOptions = {},
): Promise<string> {
  return ingestHook('claude', options, context, input);
}

export async function ingestCodexHook(
  options: RenderOptions,
  context: ClientCommandContext = {},
  input: IngestHookOptions = {},
): Promise<string> {
  return ingestHook('codex', options, context, input);
}

export async function ingestHook(
  source: HarnessSource,
  options: RenderOptions,
  context: ClientCommandContext = {},
  input: IngestHookOptions = {},
): Promise<string> {
  const parsedHookInput = parseHookInput(await readHookInput(input));
  const hookInput =
    input.inputPath === undefined || input.inputPath === '-'
      ? parsedHookInput
      : markManualHookInput(source, parsedHookInput);
  const capture = input.capture ?? ((event) => captureHook(source, event, context, input));
  const result = await capture(hookInput);

  // Default (records) is the harness invocation: return the hook JSON contract
  // exactly — harnesses depend on { continue: true } (and the systemMessage skip
  // form on failure). Non-records formats are for a human running the command.
  if (options.format === 'records') {
    return JSON.stringify(
      result.error === undefined
        ? { continue: true }
        : {
            continue: true,
            systemMessage: `Saga ${sourceDisplayName(source)} capture skipped: ${result.error}`,
          },
    );
  }

  return formatCommandOutput(
    {
      id: source,
      records: recordBlock(
        `${sourceDisplayName(source)} hook ingest`,
        [
          { label: 'source', value: result.source },
          { label: 'mode', value: result.mode },
          { label: 'accepted', value: String(result.accepted) },
          ...(result.rawEventId === undefined
            ? []
            : [{ label: 'event', value: result.rawEventId }]),
          ...(result.ackStatus === undefined ? [] : [{ label: 'ack', value: result.ackStatus }]),
          ...(result.code === undefined ? [] : [{ label: 'code', value: result.code }]),
          ...(result.rawSessionRecordId === undefined
            ? []
            : [{ label: 'raw session record', value: result.rawSessionRecordId }]),
          ...(result.error === undefined ? [] : [{ label: 'error', value: result.error }]),
        ],
        options,
      ),
      value: result,
    },
    options.format,
  );
}

export async function inspectRecentRawEvents(
  args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext = {},
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: new Set(),
    flagsWithValues: new Set(['limit', 'workspace', 'workspace-id']),
    noun: 'ingest',
  });
  // A positional first argument is a limit (apps/cli parity: `ingest recent 5`);
  // --limit is also accepted.
  const limitInput = parsed.flags.limit ?? parsed.positionals[0];
  if (parsed.positionals.length > 1) {
    throw new Error(`ingest recent received unexpected argument: ${parsed.positionals[1]}`);
  }
  const limit = parseLimit(limitInput);
  const workspaceId = resolveWorkspaceId(parsed.flags, context);

  const rows = await resolveClient(context).listEvents({ limit, workspaceId });

  return formatCommandOutput(
    {
      id: 'raw-events',
      records: renderRawEvents(rows, options),
      value: rows.map(rawEventValue),
    },
    options.format,
  );
}

export async function captureCodexHook(
  input: HarnessHookInput,
  context: ClientCommandContext = {},
  options: IngestHookOptions = {},
): Promise<CodexHookIngestResult> {
  return captureHook('codex', input, context, options);
}

export async function captureClaudeHook(
  input: HarnessHookInput,
  context: ClientCommandContext = {},
  options: IngestHookOptions = {},
): Promise<ClaudeHookIngestResult> {
  return captureHook('claude', input, context, options);
}

export async function captureHook<S extends HarnessSource>(
  source: S,
  input: HarnessHookInput,
  context: ClientCommandContext = {},
  options: IngestHookOptions = {},
): Promise<HookIngestResult & { source: S }> {
  try {
    const hookCwd = readHookString(input.cwd);
    const projectRoot = findProjectRoot(hookCwd ?? context.cwd ?? process.cwd());
    const binding = resolveHookBinding(source, projectRoot, options);
    const client = resolveClient(context);
    const now = options.now ?? new Date();

    const envelope =
      source === 'claude'
        ? rawEventFromClaudeHook(
            input,
            {
              sourceBinding: { id: binding.sourceBindingId },
              workspace: { id: binding.workspaceId },
            },
            now,
          )
        : rawEventFromCodexHook(
            input,
            {
              codexSourceBinding: { id: binding.sourceBindingId },
              workspace: { id: binding.workspaceId },
            },
            now,
          );

    const snapshot = buildIngestSnapshot({
      binding,
      hookCwd,
      hookInput: input,
      projectRoot,
      source,
    });
    const item: IngestItem = snapshot === undefined ? { envelope } : { envelope, snapshot };

    const response = await client.ingest({ items: [item] });
    const ack = response.results[0];
    if (ack === undefined) {
      return { accepted: true, error: 'ingest returned no ack', mode: 'skipped', source };
    }

    if (ack.status === 'error') {
      const message = ackErrorMessage(ack);
      // A rawEventId means the raw event persisted and the snapshot store failed
      // (captured, like the CLI inner catch); its absence means nothing persisted
      // (skipped, like the CLI outer catch).
      return ack.rawEventId === undefined
        ? {
            accepted: true,
            ackStatus: 'error',
            code: ack.code,
            error: message,
            mode: 'skipped',
            source,
          }
        : {
            accepted: true,
            ackStatus: 'error',
            code: ack.code,
            error: message,
            mode: 'captured',
            rawEventId: ack.rawEventId,
            source,
          };
    }

    return {
      accepted: true,
      ackStatus: ack.status,
      mode: 'captured',
      rawEventId: ack.rawEventId,
      rawSessionRecordId: ack.rawSessionRecordId,
      source,
    };
  } catch (error) {
    return { accepted: true, error: boundedErrorMessage(error), mode: 'skipped', source };
  }
}

// Build the IngestSnapshot the service turns back into a RawSessionImportInput
// (see apps/service buildStoreInput). The field computation mirrors apps/cli's
// buildAmbientRawSessionImportInput, minus the two fields the service derives
// itself: capturedAt (the raw event's occurredAt) and the settlement trigger (the
// inserted raw event's id). Returns undefined when there is no readable
// transcript, so the caller POSTs the envelope with NO snapshot — a
// lifecycle-boundary event the service settles server-side (mirroring the CLI's
// buildLifecycleBoundaryInput branch).
function buildIngestSnapshot(input: {
  binding: HookCaptureBinding;
  hookCwd: string | undefined;
  hookInput: HarnessHookInput;
  projectRoot: string;
  source: HarnessSource;
}): IngestSnapshot | undefined {
  const transcriptPath = readHookString(input.hookInput.transcript_path);
  if (transcriptPath === undefined) {
    return undefined;
  }
  const resolvedTranscriptPath = isAbsolute(transcriptPath)
    ? transcriptPath
    : resolve(input.hookCwd ?? input.projectRoot, transcriptPath);
  if (!existsSync(resolvedTranscriptPath)) {
    return undefined;
  }

  const rawContent = readFileSync(resolvedTranscriptPath, 'utf8');
  const hookEventName = readHookString(input.hookInput.hook_event_name);
  const sessionStartSource =
    readHookString(input.hookInput.source) ?? readHookString(input.hookInput.session_start_source);

  return {
    // The settlementTriggerRawEventId is injected server-side (the inserted raw
    // event's id), so the client omits it here.
    activity: { hookEventName, sessionStartSource },
    author: defaultAuthor(),
    contentType: inferSessionContentType(resolvedTranscriptPath, rawContent),
    harness: input.source,
    harnessMetadata: {
      hookEventName,
      permissionMode: readHookString(input.hookInput.permission_mode),
      sessionStartSource,
    },
    harnessSessionId: readHookString(input.hookInput.session_id),
    host: {
      id: input.binding.host.id,
      label: input.binding.host.label,
      projectRoot: input.projectRoot,
    },
    locator: pathToFileURL(resolvedTranscriptPath).href,
    // The CLI also stamps triggerRawEventId here; the client cannot know the
    // server-assigned raw event id, so metadata carries only importMode. This is
    // a volatile identity field the extraction job does not read (it derives from
    // rawContent + contentType), so its absence does not affect derived parity.
    metadata: { importMode: 'ambient_hook' },
    model: readHookString(input.hookInput.model),
    provenance: {
      hookEventName,
      importedBy: `saga ingest ${input.source}-hook`,
      transcriptPath: resolvedTranscriptPath,
    },
    rawContent,
    status: hookEventName === 'Stop' ? 'completed' : 'active',
  };
}

function resolveHookBinding(
  source: HarnessSource,
  projectRoot: string,
  options: IngestHookOptions,
): HookCaptureBinding {
  if (options.binding !== undefined) {
    return options.binding;
  }
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error('workspace binding is missing; run saga init');
  }
  const sourceBinding = binding.harnesses?.[source];
  if (sourceBinding === undefined) {
    throw new Error(
      `${sourceDisplayName(source)} harness is not installed; run saga harness install ${source}`,
    );
  }
  if (
    typeof sourceBinding.sourceBindingId !== 'string' ||
    sourceBinding.sourceBindingId.trim() === ''
  ) {
    throw new Error(
      `${sourceDisplayName(source)} harness binding is invalid: sourceBindingId is missing`,
    );
  }
  if (binding.host === undefined || binding.host.id.trim() === '') {
    throw new Error(
      `${sourceDisplayName(source)} harness binding is stale: local host id is missing`,
    );
  }
  return {
    host: { id: binding.host.id, label: binding.host.label },
    sourceBindingId: sourceBinding.sourceBindingId,
    workspaceId: binding.workspace.id,
  };
}

function ackErrorMessage(ack: IngestItemResult): string {
  return ack.code === undefined ? 'ingest failed' : `ingest failed: ${ack.code}`;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

function inferSessionContentType(path: string, rawContent: string): IngestSnapshot['contentType'] {
  const extension = extname(path).toLowerCase();
  if (extension === '.json') {
    return 'json';
  }
  if (extension === '.jsonl' || extension === '.ndjson') {
    return 'jsonl';
  }

  const trimmed = rawContent.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return 'json';
  }
  if (trimmed.split(/\r?\n/u).every((line) => line.trim() === '' || line.trim().startsWith('{'))) {
    return 'jsonl';
  }
  return 'text';
}

function defaultAuthor(): IngestSnapshot['author'] {
  const user = userInfo();
  return {
    displayName: user.username,
    handle: user.username,
    externalSubject: user.username,
  };
}

function readHookString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function parseHookInput(stdin: string): HarnessHookInput {
  const trimmed = stdin.trim();
  if (trimmed === '') {
    return {};
  }
  const parsed = JSON.parse(trimmed) as unknown;
  return isRecord(parsed) ? parsed : { payload: parsed };
}

function markManualHookInput(source: HarnessSource, input: HarnessHookInput): HarnessHookInput {
  return {
    ...input,
    captureMode: 'manual',
    ingestOrigin: `saga ingest ${source}-hook <file>`,
    manual: true,
    sagaManualIngest: true,
  };
}

async function readHookInput(input: IngestHookOptions): Promise<string> {
  if (input.stdin !== undefined) {
    return input.stdin;
  }
  if (input.inputPath !== undefined && input.inputPath !== '-') {
    if (!existsSync(input.inputPath)) {
      throw new Error(`input file not found: ${input.inputPath}`);
    }
    return readFileSync(input.inputPath, 'utf8');
  }
  return readStdin();
}

function sourceDisplayName(source: HarnessSource): string {
  if (source === 'claude') {
    return 'Claude Code';
  }
  return 'Codex';
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || String(limit) !== value) {
    throw new Error(`invalid raw event limit: ${value}`);
  }
  return limit;
}

function renderRawEvents(rows: readonly RawEvent[], options: RenderOptions): string {
  if (rows.length === 0) {
    return recordBlock('Raw events', [{ label: 'events', value: 'none' }], options);
  }

  const fields = rows.flatMap((row, index) => [
    { label: `event ${String(index + 1)}`, value: row.eventType },
    { label: 'id', value: row.id },
    { label: 'session', value: row.sessionId ?? 'none' },
    { label: 'occurred', value: row.occurredAt },
  ]);
  return recordBlock('Raw events', fields, options);
}

function rawEventValue(row: RawEvent): Record<string, unknown> {
  return {
    eventType: row.eventType,
    externalEventId: row.externalEventId,
    id: row.id,
    ingestedAt: row.ingestedAt,
    occurredAt: row.occurredAt,
    payload: row.payload,
    provenance: row.provenance,
    sessionId: row.sessionId,
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    traceId: row.traceId,
    trustLevel: row.trustLevel,
    workspaceId: row.workspaceId,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
