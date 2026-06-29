import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  deleteSessionSafety,
  getSessionDetail,
  importRawSessionRecord,
  listRecentSessionRecords,
  makeDatabase,
  redactAgentFacingSessionValue,
  redactSessionSafety,
  type DeleteSessionSafetyInput,
  type DeleteSessionSafetyResult,
  type GetSessionDetailInput,
  type ListRecentSessionRecordsInput,
  type RawSessionContentType,
  type RawSessionHarness,
  type RawSessionImportInput,
  type RawSessionImportResult,
  type RecentSessionRecord,
  type RedactSessionSafetyInput,
  type RedactSessionSafetyResult,
  type SessionDetail,
  type SessionDetailSegment,
  type SessionDetailTurn,
  type SessionRawSessionRecordMetadata,
  type SessionRedactionPattern,
} from '@saga/db';
import { loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import {
  type WorkspaceBindingFile,
  type WorkspaceBindingFileWithHost,
  findProjectRoot,
  readBindingFile,
  writeBindingFile,
  ensureLocalHostBinding,
} from './init.js';
import { formatCommandOutput } from './output.js';
import { recordBlock, separator, type RenderOptions } from './render.js';

const IMPORT_FLAGS_WITH_VALUES = new Set([
  'author',
  'author-name',
  'captured-at',
  'content-type',
  'harness',
  'harness-metadata',
  'harness-session-id',
  'host-id',
  'host-label',
  'host-project-root',
  'locator',
  'metadata',
  'model',
  'provenance',
  'status',
  'title',
]);
const IMPORT_BOOLEAN_FLAGS = new Set<string>();
const RECENT_FLAGS_WITH_VALUES = new Set(['harness', 'limit']);
const RECENT_BOOLEAN_FLAGS = new Set(['active-only']);
const SHOW_FLAGS_WITH_VALUES = new Set(['raw-records', 'segments', 'turns']);
const SHOW_BOOLEAN_FLAGS = new Set(['raw-body']);
const DELETE_FLAGS_WITH_VALUES = new Set(['origin', 'reason']);
const DELETE_BOOLEAN_FLAGS = new Set<string>();
const REDACT_FLAGS_WITH_VALUES = new Set([
  'literal',
  'origin',
  'reason',
  'regex',
  'regex-flags',
  'replacement',
]);
const REDACT_BOOLEAN_FLAGS = new Set<string>();

export interface SessionsCommandDependencies {
  cwd?: string | undefined;
  deleteSession?:
    | ((input: DeleteSessionSafetyInput) => Promise<DeleteSessionSafetyResult>)
    | undefined;
  getDetail?: ((input: GetSessionDetailInput) => Promise<SessionDetail>) | undefined;
  importRecord?: ((input: RawSessionImportInput) => Promise<RawSessionImportResult>) | undefined;
  listRecent?:
    | ((input: ListRecentSessionRecordsInput) => Promise<RecentSessionRecord[]>)
    | undefined;
  readStdin?: (() => Promise<string>) | undefined;
  redactSession?:
    | ((input: RedactSessionSafetyInput) => Promise<RedactSessionSafetyResult>)
    | undefined;
}

export async function runSessionsCommand(
  args: readonly string[],
  options: RenderOptions,
  dependencies: SessionsCommandDependencies = {},
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === 'import') {
    return importSession(args.slice(1), options, dependencies);
  }
  if (subcommand === 'delete') {
    return deleteSession(args.slice(1), options, dependencies);
  }
  if (subcommand === 'recent') {
    return recentSessions(args.slice(1), options, dependencies);
  }
  if (subcommand === 'redact') {
    return redactSession(args.slice(1), options, dependencies);
  }
  if (subcommand === 'show') {
    return showSession(args.slice(1), options, dependencies);
  }
  throw new Error(`sessions ${subcommand ?? ''} is not implemented yet`.trim());
}

async function importSession(
  args: readonly string[],
  options: RenderOptions,
  dependencies: SessionsCommandDependencies,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: IMPORT_BOOLEAN_FLAGS,
    flagsWithValues: IMPORT_FLAGS_WITH_VALUES,
  });
  const inputPath = parsed.positionals[0];
  if (inputPath === undefined) {
    throw new Error(
      'sessions import requires an input file: saga sessions import <file> --harness codex|claude',
    );
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`sessions import received unexpected argument: ${parsed.positionals[1]}`);
  }

  const project = loadBoundProjectWithHost(dependencies.cwd);
  const rawContent = await readSessionInput(inputPath, dependencies);
  const importInput = buildImportInput({
    flags: parsed.flags,
    inputPath,
    project,
    rawContent,
  });

  const result =
    dependencies.importRecord === undefined
      ? await withDatabase(project.projectRoot, async (service) =>
          Effect.runPromise(importRawSessionRecord(service, importInput)),
        )
      : await dependencies.importRecord(importInput);

  return formatCommandOutput(
    {
      id: result.rawSessionRecord.id,
      records: renderImportResult(result, options),
      value: redactAgentFacingSessionValue(importResultValue(result)),
    },
    options.format,
  );
}

async function deleteSession(
  args: readonly string[],
  options: RenderOptions,
  dependencies: SessionsCommandDependencies,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: DELETE_BOOLEAN_FLAGS,
    flagsWithValues: DELETE_FLAGS_WITH_VALUES,
  });
  const id = parsed.positionals[0];
  if (id === undefined) {
    throw new Error('sessions delete requires a session id or raw session record id');
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`sessions delete received unexpected argument: ${parsed.positionals[1]}`);
  }

  const project = loadBoundProject(dependencies.cwd);
  const input: DeleteSessionSafetyInput = {
    id,
    origin: parsed.flags.origin ?? 'saga sessions delete',
    reason: parsed.flags.reason,
    workspaceId: project.binding.workspace.id,
  };
  const result =
    dependencies.deleteSession === undefined
      ? await withDatabase(project.projectRoot, async (service) =>
          Effect.runPromise(deleteSessionSafety(service, input)),
        )
      : await dependencies.deleteSession(input);

  return formatCommandOutput(
    {
      id: result.sessionId,
      records: renderDeleteResult(result, options),
      value: result,
    },
    options.format,
  );
}

async function recentSessions(
  args: readonly string[],
  options: RenderOptions,
  dependencies: SessionsCommandDependencies,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: RECENT_BOOLEAN_FLAGS,
    flagsWithValues: RECENT_FLAGS_WITH_VALUES,
  });
  if (parsed.positionals.length > 0) {
    throw new Error(`sessions recent received unexpected argument: ${parsed.positionals[0]}`);
  }

  const project = loadBoundProject(dependencies.cwd);
  const input: ListRecentSessionRecordsInput = {
    activeOnly: parsed.booleans.has('active-only'),
    harness: parsed.flags.harness,
    limit: parsePositiveIntegerFlag(parsed.flags.limit, 'limit'),
    workspaceId: project.binding.workspace.id,
  };
  const rows =
    dependencies.listRecent === undefined
      ? await withDatabase(project.projectRoot, async (service) =>
          Effect.runPromise(listRecentSessionRecords(service, input)),
        )
      : await dependencies.listRecent(input);

  return formatCommandOutput(
    {
      id: rows.map((row) => row.rawSessionRecord.id).join('\n'),
      records: renderRecentSessions(rows, options),
      value: redactAgentFacingSessionValue(rows),
    },
    options.format,
  );
}

async function redactSession(
  args: readonly string[],
  options: RenderOptions,
  dependencies: SessionsCommandDependencies,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: REDACT_BOOLEAN_FLAGS,
    flagsWithValues: REDACT_FLAGS_WITH_VALUES,
  });
  const id = parsed.positionals[0];
  if (id === undefined) {
    throw new Error('sessions redact requires a session id or active raw session record id');
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`sessions redact received unexpected argument: ${parsed.positionals[1]}`);
  }

  const patterns = buildRedactionPatterns(parsed);
  const project = loadBoundProject(dependencies.cwd);
  const input: RedactSessionSafetyInput = {
    id,
    origin: parsed.flags.origin ?? 'saga sessions redact',
    patterns,
    reason: parsed.flags.reason,
    workspaceId: project.binding.workspace.id,
  };
  const result =
    dependencies.redactSession === undefined
      ? await withDatabase(project.projectRoot, async (service) =>
          Effect.runPromise(redactSessionSafety(service, input)),
        )
      : await dependencies.redactSession(input);

  return formatCommandOutput(
    {
      id: result.rawSessionImport.rawSessionRecord.id,
      records: renderRedactResult(result, options),
      value: redactAgentFacingSessionValue(result),
    },
    options.format,
  );
}

async function showSession(
  args: readonly string[],
  options: RenderOptions,
  dependencies: SessionsCommandDependencies,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: SHOW_BOOLEAN_FLAGS,
    flagsWithValues: SHOW_FLAGS_WITH_VALUES,
  });
  const id = parsed.positionals[0];
  if (id === undefined) {
    throw new Error('sessions show requires a session id or raw session record id');
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`sessions show received unexpected argument: ${parsed.positionals[1]}`);
  }

  const project = loadBoundProject(dependencies.cwd);
  const input: GetSessionDetailInput = {
    id,
    includeRawBody: parsed.booleans.has('raw-body'),
    maxRawRecords: parsePositiveIntegerFlag(parsed.flags['raw-records'], 'raw-records'),
    maxSegmentsPerTurn: parsePositiveIntegerFlag(parsed.flags.segments, 'segments'),
    maxTurns: parsePositiveIntegerFlag(parsed.flags.turns, 'turns'),
    workspaceId: project.binding.workspace.id,
  };
  const detail =
    dependencies.getDetail === undefined
      ? await withDatabase(project.projectRoot, async (service) =>
          Effect.runPromise(getSessionDetail(service, input)),
        )
      : await dependencies.getDetail(input);

  return formatCommandOutput(
    {
      id: detail.session.id,
      records: renderSessionDetail(detail, options),
      value: sessionDetailValue(detail),
    },
    options.format,
  );
}

interface BoundProject {
  binding: WorkspaceBindingFile;
  projectRoot: string;
}

interface BoundProjectWithHost {
  binding: WorkspaceBindingFileWithHost;
  projectRoot: string;
}

function loadBoundProject(cwd: string | undefined): BoundProject {
  const projectRoot = findProjectRoot(cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error('workspace binding is missing; run saga init');
  }
  return { binding, projectRoot };
}

function loadBoundProjectWithHost(cwd: string | undefined): BoundProjectWithHost {
  const project = loadBoundProject(cwd);
  const rawBinding = project.binding;
  const binding = ensureLocalHostBinding(rawBinding);
  if (rawBinding.host === undefined) {
    writeBindingFile(project.projectRoot, binding);
  }
  return { binding, projectRoot: project.projectRoot };
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

function buildImportInput(input: {
  flags: Record<string, string>;
  inputPath: string;
  project: BoundProjectWithHost;
  rawContent: string;
}): RawSessionImportInput {
  const harness = parseHarness(input.flags.harness);
  const contentType =
    input.flags['content-type'] === undefined
      ? inferContentType(input.inputPath)
      : parseContentType(input.flags['content-type']);
  const metadata = parseJsonObjectFlag(input.flags.metadata, 'metadata');
  const harnessMetadata = parseJsonObjectFlag(input.flags['harness-metadata'], 'harness-metadata');
  const provenance = parseJsonObjectFlag(input.flags.provenance, 'provenance');
  const authorHandle = input.flags.author ?? defaultAuthorHandle();
  const hostId = input.flags['host-id'] ?? input.project.binding.host.id;
  const hostLabel = input.flags['host-label'] ?? input.project.binding.host.label;
  const locator =
    input.flags.locator ??
    (input.inputPath === '-' ? undefined : pathToFileURL(resolve(input.inputPath)).href);
  const capturedAt = input.flags['captured-at'];
  const status = parseStatus(input.flags.status);

  return {
    author: {
      displayName: input.flags['author-name'],
      handle: authorHandle,
    },
    capturedAt,
    contentType,
    harness,
    harnessMetadata,
    harnessSessionId: input.flags['harness-session-id'],
    host: {
      id: hostId,
      label: hostLabel,
      projectRoot: input.flags['host-project-root'] ?? input.project.projectRoot,
    },
    locator,
    metadata: {
      importMode: 'manual',
      ...metadata,
    },
    model: input.flags.model,
    provenance: {
      importedBy: 'saga sessions import',
      importedAt: new Date().toISOString(),
      ...provenance,
    },
    rawContent: input.rawContent,
    status,
    title: input.flags.title,
    workspaceId: input.project.binding.workspace.id,
  };
}

function renderImportResult(result: RawSessionImportResult, options: RenderOptions): string {
  return recordBlock(
    'Raw Session Record imported',
    [
      { label: 'operation', value: result.operation },
      { label: 'raw record', value: result.rawSessionRecord.id },
      { label: 'session', value: result.session.id },
      { label: 'activity interval', value: result.activityInterval.id },
      { label: 'snapshot', value: String(result.rawSessionRecord.snapshotOrdinal) },
      { label: 'active', value: String(result.rawSessionRecord.isActive) },
      { label: 'harness', value: result.rawSessionRecord.harness },
      { label: 'harness session', value: result.rawSessionRecord.harnessSessionId ?? 'none' },
      { label: 'model', value: result.session.model ?? 'none' },
      { label: 'host-user', value: result.authorUser.handle },
      { label: 'source', value: result.sourceBinding.sourceUri },
      { label: 'captured', value: result.rawSessionRecord.capturedAt.toISOString() },
      { label: 'content', value: result.rawSessionRecord.contentType },
      { label: 'bytes', value: String(result.rawSessionRecord.contentBytes ?? 0) },
      {
        label: 'provenance',
        value: safeCompactJson(result.rawSessionRecord.provenance),
      },
    ],
    options,
  );
}

function renderDeleteResult(result: DeleteSessionSafetyResult, options: RenderOptions): string {
  return recordBlock(
    'Session deleted',
    [
      { label: 'session', value: result.sessionId },
      { label: 'workspace', value: result.workspaceId },
      { label: 'deleted', value: result.deletedAt.toISOString() },
      { label: 'origin', value: result.originClassification },
      { label: 'reason provided', value: String(result.reasonProvided) },
      { label: 'raw records', value: String(result.deleted.rawSessionRecords) },
      { label: 'raw events', value: String(result.deleted.rawEvents) },
      { label: 'turns', value: String(result.deleted.turns) },
      { label: 'segments', value: String(result.deleted.segments) },
      { label: 'embeddings', value: String(result.deleted.embeddings) },
    ],
    options,
  );
}

function renderRedactResult(result: RedactSessionSafetyResult, options: RenderOptions): string {
  return recordBlock(
    'Session redacted',
    [
      { label: 'session', value: result.sessionId },
      { label: 'workspace', value: result.workspaceId },
      { label: 'previous raw record', value: result.previousRawSessionRecordId },
      { label: 'active raw record', value: result.rawSessionImport.rawSessionRecord.id },
      {
        label: 'snapshot',
        value: String(result.rawSessionImport.rawSessionRecord.snapshotOrdinal),
      },
      { label: 'redacted', value: result.redactedAt.toISOString() },
      { label: 'origin', value: result.originClassification },
      { label: 'reason provided', value: String(result.reasonProvided) },
      { label: 'patterns', value: String(result.patternCount) },
      { label: 'replacements', value: String(result.replacementCount) },
      { label: 'raw events', value: String(result.redactedRawEvents) },
    ],
    options,
  );
}

function renderRecentSessions(
  rows: readonly RecentSessionRecord[],
  options: RenderOptions,
): string {
  if (rows.length === 0) {
    return recordBlock('Raw Session Records', [{ label: 'records', value: 'none' }], options);
  }

  const fields = rows.flatMap((row, index) => [
    { label: `raw record ${String(index + 1)}`, value: row.rawSessionRecord.id },
    { label: 'session', value: row.session.id },
    { label: 'Activity Interval', value: row.activityInterval?.id ?? 'none' },
    { label: 'harness', value: row.rawSessionRecord.harness },
    { label: 'model', value: row.session.model ?? 'none' },
    { label: 'host-user', value: row.authorUser.handle },
    { label: 'active', value: String(row.rawSessionRecord.isActive) },
    { label: 'captured', value: row.rawSessionRecord.capturedAt.toISOString() },
    {
      label: 'counts',
      value: `${String(row.counts.activityIntervals)} intervals, ${String(row.counts.turns)} turns, ${String(row.counts.segments)} segments`,
    },
    { label: 'provenance', value: safeCompactJson(row.rawSessionRecord.provenance) },
  ]);
  return recordBlock('Raw Session Records', fields, options);
}

function renderSessionDetail(detail: SessionDetail, options: RenderOptions): string {
  const blocks = [
    recordBlock(
      'Session',
      [
        { label: 'session', value: detail.session.id },
        { label: 'title', value: detail.session.title ?? 'none' },
        { label: 'status', value: detail.session.status },
        { label: 'harness', value: detail.session.harness },
        { label: 'harness session', value: detail.session.harnessSessionId ?? 'none' },
        { label: 'model', value: detail.session.model ?? 'none' },
        { label: 'source locator', value: safeString(detail.session.sourceLocator) },
        { label: 'started', value: formatDate(detail.session.startedAt) },
        { label: 'last activity', value: formatDate(detail.session.lastActivityAt) },
        { label: 'ended', value: formatDate(detail.session.endedAt) },
        { label: 'metadata', value: safeCompactJson(detail.session.metadata) },
        { label: 'provenance', value: safeCompactJson(detail.session.provenance) },
      ],
      options,
    ),
    recordBlock(
      'host-user',
      [
        { label: 'handle', value: detail.authorUser.handle },
        { label: 'display', value: detail.authorUser.displayName ?? 'none' },
        { label: 'identity', value: detail.authorUser.identitySource },
        { label: 'external', value: detail.authorUser.externalSubject ?? 'none' },
        { label: 'metadata', value: safeCompactJson(detail.authorUser.metadata) },
      ],
      options,
    ),
    recordBlock(
      'Source binding',
      [
        { label: 'source', value: detail.sourceBinding.sourceUri },
        { label: 'type', value: detail.sourceBinding.sourceType },
        { label: 'enabled', value: String(detail.sourceBinding.enabled) },
        { label: 'metadata', value: safeCompactJson(detail.sourceBinding.config) },
      ],
      options,
    ),
  ];

  const rawBodyWarning = rawBodyExposureWarning(detail);
  if (rawBodyWarning !== undefined) {
    blocks.push(
      recordBlock(
        'Raw Body Exposure',
        [
          { label: 'WARNING', value: rawBodyWarning },
          { label: 'mode', value: 'raw forensic' },
          { label: 'requested by', value: '--raw-body' },
        ],
        options,
      ),
    );
  }

  const renderedRawRecordIds = new Set<string>();
  for (const record of detail.rawSessionRecords) {
    renderedRawRecordIds.add(record.id);
    blocks.push(renderRawSessionRecord('Raw Session Record', record, options));
  }
  if (
    detail.activeRawSessionRecord !== null &&
    !renderedRawRecordIds.has(detail.activeRawSessionRecord.id)
  ) {
    blocks.push(
      renderRawSessionRecord('Active Raw Session Record', detail.activeRawSessionRecord, options),
    );
    renderedRawRecordIds.add(detail.activeRawSessionRecord.id);
  }
  if (
    detail.selectedRawSessionRecord !== null &&
    !renderedRawRecordIds.has(detail.selectedRawSessionRecord.id)
  ) {
    blocks.push(
      renderRawSessionRecord(
        'Selected Raw Session Record',
        detail.selectedRawSessionRecord,
        options,
      ),
    );
  }

  for (const interval of detail.activityIntervals) {
    blocks.push(
      recordBlock(
        `Activity Interval ${String(interval.activityInterval.ordinal)}`,
        [
          { label: 'id', value: interval.activityInterval.id },
          { label: 'status', value: interval.activityInterval.status },
          { label: 'started', value: interval.activityInterval.startedAt.toISOString() },
          { label: 'ended', value: formatDate(interval.activityInterval.endedAt) },
          { label: 'settled', value: formatDate(interval.activityInterval.settledAt) },
          { label: 'settlement', value: interval.activityInterval.settlementReason ?? 'none' },
          { label: 'metadata', value: safeCompactJson(interval.activityInterval.metadata) },
        ],
        options,
      ),
    );
    for (const turn of interval.turns) {
      blocks.push(renderTurn(turn, options));
      for (const segment of turn.segments) {
        blocks.push(renderSegment(segment, options));
      }
    }
  }

  if (detail.truncated.rawSessionRecords || detail.truncated.turns || detail.truncated.segments) {
    blocks.push(
      recordBlock(
        'Bounds',
        [
          { label: 'raw records', value: truncateState(detail.truncated.rawSessionRecords) },
          { label: 'turns', value: truncateState(detail.truncated.turns) },
          { label: 'segments', value: truncateState(detail.truncated.segments) },
          {
            label: 'limits',
            value: `${String(detail.limits.maxRawRecords)} raw records, ${String(detail.limits.maxTurns)} turns, ${String(detail.limits.maxSegmentsPerTurn)} segments/turn`,
          },
        ],
        options,
      ),
    );
  }

  return blocks.join(`\n${separator(options)}\n`);
}

function renderRawSessionRecord(
  title: string,
  record: SessionRawSessionRecordMetadata,
  options: RenderOptions,
): string {
  const exposesRawBody = hasRawBodyExposure(record);
  return recordBlock(
    title,
    [
      { label: 'id', value: record.id },
      { label: 'session', value: record.sessionId },
      { label: 'snapshot', value: String(record.snapshotOrdinal) },
      { label: 'active', value: String(record.isActive) },
      { label: 'status', value: record.status },
      { label: 'harness', value: record.harness },
      { label: 'harness session', value: record.harnessSessionId ?? 'none' },
      { label: 'locator', value: safeString(record.sourceLocator) },
      { label: 'captured', value: record.capturedAt.toISOString() },
      {
        label: 'content',
        value: `${record.contentType}, ${String(record.contentBytes ?? 0)} bytes`,
      },
      { label: 'hash', value: record.contentHash },
      { label: 'metadata', value: safeCompactJson(record.metadata) },
      { label: 'provenance', value: safeCompactJson(record.provenance) },
      ...(!exposesRawBody
        ? []
        : [
            {
              label: 'raw body warning',
              value: record.rawBodyExposure.warning,
            },
          ]),
      ...(!exposesRawBody || record.bodyText === undefined
        ? []
        : [{ label: 'raw forensic body text', value: record.bodyText ?? 'none' }]),
      ...(!exposesRawBody || record.bodyJson === undefined
        ? []
        : [{ label: 'raw forensic body json', value: compactJson(record.bodyJson) }]),
    ],
    options,
  );
}

function sessionDetailValue(detail: SessionDetail): unknown {
  const redacted = redactAgentFacingSessionValue(detail);
  if (!isRecord(redacted)) return redacted;
  restoreRawForensicBodies(redacted, detail);
  return redacted;
}

function restoreRawForensicBodies(redacted: Record<string, unknown>, detail: SessionDetail): void {
  restoreRawRecord(redacted.activeRawSessionRecord, detail.activeRawSessionRecord);
  restoreRawRecord(redacted.selectedRawSessionRecord, detail.selectedRawSessionRecord);
  if (Array.isArray(redacted.rawSessionRecords)) {
    for (let index = 0; index < redacted.rawSessionRecords.length; index += 1) {
      restoreRawRecord(redacted.rawSessionRecords[index], detail.rawSessionRecords[index]);
    }
  }
}

function restoreRawRecord(
  redactedRecord: unknown,
  originalRecord: SessionRawSessionRecordMetadata | null | undefined,
): void {
  if (!isRecord(redactedRecord) || originalRecord === null || originalRecord === undefined) return;
  if (!hasRawBodyExposure(originalRecord)) return;
  if (Object.hasOwn(originalRecord, 'bodyText')) redactedRecord.bodyText = originalRecord.bodyText;
  if (Object.hasOwn(originalRecord, 'bodyJson')) redactedRecord.bodyJson = originalRecord.bodyJson;
}

function rawBodyExposureWarning(detail: SessionDetail): string | undefined {
  return (
    detail.rawSessionRecords.find(hasRawBodyExposure)?.rawBodyExposure?.warning ??
    (hasRawBodyExposure(detail.activeRawSessionRecord)
      ? detail.activeRawSessionRecord.rawBodyExposure.warning
      : undefined) ??
    (hasRawBodyExposure(detail.selectedRawSessionRecord)
      ? detail.selectedRawSessionRecord.rawBodyExposure.warning
      : undefined)
  );
}

function hasRawBodyExposure(
  record: SessionRawSessionRecordMetadata | null | undefined,
): record is SessionRawSessionRecordMetadata & {
  rawBodyExposure: NonNullable<SessionRawSessionRecordMetadata['rawBodyExposure']>;
} {
  const warning = record?.rawBodyExposure?.warning;
  return (
    record?.rawBodyExposure?.mode === 'raw_forensic' &&
    record.rawBodyExposure.requestedBy === 'includeRawBody' &&
    typeof warning === 'string' &&
    warning.trim().length > 0
  );
}

function renderTurn(turn: SessionDetailTurn, options: RenderOptions): string {
  return recordBlock(
    `Turn ${String(turn.turn.ordinal)}`,
    [
      { label: 'id', value: turn.turn.id },
      { label: 'role', value: turn.turn.role },
      { label: 'actor', value: `${turn.turn.actorKind}:${turn.turn.actorLabel ?? 'none'}` },
      { label: 'harness turn', value: turn.turn.harnessTurnId ?? 'none' },
      { label: 'model', value: turn.turn.model ?? 'none' },
      { label: 'started', value: formatDate(turn.startedAt) },
      { label: 'ended', value: formatDate(turn.endedAt) },
      { label: 'parts', value: safeCompactJson(turn.contentParts) },
      {
        label: 'raw events',
        value: turn.rawEventIds.length === 0 ? 'none' : turn.rawEventIds.join(', '),
      },
      { label: 'raw span', value: safeCompactJson(turn.rawSpan) },
      { label: 'metadata', value: safeCompactJson(turn.metadata) },
    ],
    options,
  );
}

function renderSegment(segment: SessionDetailSegment, options: RenderOptions): string {
  return recordBlock(
    `Segment ${String(segment.ordinal)}`,
    [
      { label: 'id', value: segment.id },
      { label: 'kind', value: segment.segmentKind },
      { label: 'tokens', value: formatRange(segment.tokenStart, segment.tokenEnd) },
      { label: 'chars', value: formatRange(segment.charStart, segment.charEnd) },
      { label: 'snippet', value: segment.snippet === null ? 'none' : safeText(segment.snippet) },
      { label: 'text', value: truncate(safeText(segment.searchText), 280) },
      { label: 'metadata', value: safeCompactJson(segment.metadata) },
    ],
    options,
  );
}

function importResultValue(result: RawSessionImportResult): Record<string, unknown> {
  return {
    activityInterval: result.activityInterval,
    authorUser: result.authorUser,
    contentHash: result.contentHash,
    operation: result.operation,
    rawSessionRecord: result.rawSessionRecord,
    session: result.session,
    sourceBinding: result.sourceBinding,
  };
}

async function readSessionInput(
  inputPath: string,
  dependencies: SessionsCommandDependencies,
): Promise<string> {
  if (inputPath === '-') {
    return dependencies.readStdin === undefined ? readStdin() : dependencies.readStdin();
  }
  if (!existsSync(inputPath)) {
    throw new Error(`input file not found: ${inputPath}`);
  }
  return readFileSync(inputPath, 'utf8');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface LocalOptions {
  booleans: Set<string>;
  flagValues: Record<string, string[]>;
  flags: Record<string, string>;
  positionals: string[];
}

function parseLocalOptions(
  args: readonly string[],
  spec: { booleanFlags: ReadonlySet<string>; flagsWithValues: ReadonlySet<string> },
): LocalOptions {
  const booleans = new Set<string>();
  const flagValues: Record<string, string[]> = {};
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
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
      if (inlineValue !== undefined) throw new Error(`--${name} does not take a value`);
      booleans.add(name);
      continue;
    }
    if (!spec.flagsWithValues.has(name)) {
      throw new Error(`unknown sessions option: --${name}`);
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined) throw new Error(`--${name} expects a value`);
    flags[name] = value;
    flagValues[name] = [...(flagValues[name] ?? []), value];
    if (inlineValue === undefined) index += 1;
  }

  return { booleans, flagValues, flags, positionals };
}

function buildRedactionPatterns(parsed: LocalOptions): SessionRedactionPattern[] {
  const replacement = parsed.flags.replacement ?? '[REDACTED]';
  const literalPatterns = parsed.flagValues.literal ?? [];
  const regexPatterns = parsed.flagValues.regex ?? [];
  const patterns: SessionRedactionPattern[] = [
    ...literalPatterns.map((pattern) => ({
      kind: 'literal' as const,
      pattern,
      replacement,
    })),
    ...regexPatterns.map((pattern) => ({
      flags: parsed.flags['regex-flags'],
      kind: 'regex' as const,
      pattern,
      replacement,
    })),
  ];
  if (patterns.length === 0) {
    throw new Error('sessions redact requires at least one --literal or --regex pattern');
  }
  return patterns;
}

function parseHarness(value: string | undefined): RawSessionHarness {
  if (value === 'claude' || value === 'codex') return value;
  throw new Error('sessions import requires --harness claude|codex');
}

function parseContentType(value: string): RawSessionContentType {
  if (value === 'json' || value === 'jsonl' || value === 'text') return value;
  throw new Error(`unsupported content type: ${value}`);
}

function inferContentType(inputPath: string): RawSessionContentType {
  const extension = extname(inputPath).toLowerCase();
  if (extension === '.jsonl' || extension === '.ndjson') return 'jsonl';
  if (extension === '.json') return 'json';
  return 'text';
}

function parseStatus(value: string | undefined): 'active' | 'completed' | undefined {
  if (value === undefined) return undefined;
  if (value === 'active' || value === 'completed') return value;
  throw new Error(`unsupported session status: ${value}`);
}

function parseJsonObjectFlag(value: string | undefined, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`--${label} must be a JSON object`);
  }
  return parsed;
}

function parsePositiveIntegerFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`--${label} must be a positive integer`);
  }
  return parsed;
}

function defaultAuthorHandle(): string {
  try {
    return process.env.USER ?? userInfo().username;
  } catch {
    return 'host-user';
  }
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? 'undefined' : truncate(json, 220);
}

function safeCompactJson(value: unknown): string {
  return compactJson(redactAgentFacingSessionValue(value));
}

function safeString(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'none';
  const redacted = redactAgentFacingSessionValue(value);
  return typeof redacted === 'string' ? redacted : 'none';
}

function safeText(value: string): string {
  const redacted = redactAgentFacingSessionValue(value);
  return typeof redacted === 'string' ? redacted : '';
}

function formatDate(value: Date | null): string {
  return value === null ? 'none' : value.toISOString();
}

function formatRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return 'none';
  return `${start === null ? '?' : String(start)}..${end === null ? '?' : String(end)}`;
}

function truncateState(value: boolean): string {
  return value ? 'truncated' : 'complete';
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
