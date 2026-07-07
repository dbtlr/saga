import type {
  GetSessionRequest,
  ListSessionsRequest,
  RawSessionRecordMetadata,
  RecentSessionRecord,
  SessionDetail,
  SessionDetailSegment,
  SessionDetailTurn,
} from '@saga/api-client';

import { parseLocalOptions, parsePositiveIntegerFlag } from './command-args.js';
import { resolveClient, resolveWorkspaceId } from './command-context.js';
import type { ClientCommandContext } from './command-context.js';
import { compactJson, formatDate, formatRange, truncate } from './command-format.js';
import { formatCommandOutput } from './output.js';
import { recordBlock, separator } from './render.js';
import type { RenderOptions } from './render.js';

const RECENT_FLAGS_WITH_VALUES = new Set(['harness', 'limit', 'workspace', 'workspace-id']);
const RECENT_BOOLEAN_FLAGS = new Set(['active-only']);
const SHOW_FLAGS_WITH_VALUES = new Set([
  'raw-records',
  'segments',
  'turns',
  'workspace',
  'workspace-id',
]);
const SHOW_BOOLEAN_FLAGS = new Set(['raw-body']);

export async function runSessionsCommand(
  args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext = {},
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === 'recent') {
    return recentSessions(args.slice(1), options, context);
  }
  if (subcommand === 'show') {
    return showSession(args.slice(1), options, context);
  }
  // import/delete/redact are out of scope for the client surface (SGA-239):
  // they are write/lifecycle operations that stay on the local db-backed CLI.
  throw new Error(`sessions ${subcommand ?? ''} is not implemented yet`.trim());
}

async function recentSessions(
  args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: RECENT_BOOLEAN_FLAGS,
    flagsWithValues: RECENT_FLAGS_WITH_VALUES,
    noun: 'sessions',
  });
  if (parsed.positionals.length > 0) {
    throw new Error(`sessions recent received unexpected argument: ${parsed.positionals[0]}`);
  }

  const request: ListSessionsRequest = {
    activeOnly: parsed.booleans.has('active-only'),
    harness: parsed.flags.harness,
    limit: parsePositiveIntegerFlag(parsed.flags.limit, 'limit'),
    workspaceId: resolveWorkspaceId(parsed.flags, context),
  };
  const rows = await resolveClient(context).listSessions(request);

  return formatCommandOutput(
    {
      id: rows.map((row) => row.rawSessionRecord.id).join('\n'),
      records: renderRecentSessions(rows, options),
      value: rows,
    },
    options.format,
  );
}

async function showSession(
  args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: SHOW_BOOLEAN_FLAGS,
    flagsWithValues: SHOW_FLAGS_WITH_VALUES,
    noun: 'sessions',
  });
  const id = parsed.positionals[0];
  if (id === undefined) {
    throw new Error('sessions show requires a session id or raw session record id');
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`sessions show received unexpected argument: ${parsed.positionals[1]}`);
  }

  const request: GetSessionRequest = {
    includeRawBody: parsed.booleans.has('raw-body'),
    maxRawRecords: parsePositiveIntegerFlag(parsed.flags['raw-records'], 'raw-records'),
    maxSegmentsPerTurn: parsePositiveIntegerFlag(parsed.flags.segments, 'segments'),
    maxTurns: parsePositiveIntegerFlag(parsed.flags.turns, 'turns'),
    workspaceId: resolveWorkspaceId(parsed.flags, context),
  };
  const detail = await resolveClient(context).getSession(id, request);

  return formatCommandOutput(
    {
      id: detail.session.id,
      records: renderSessionDetail(detail, options),
      value: detail,
    },
    options.format,
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
    { label: 'captured', value: row.rawSessionRecord.capturedAt },
    {
      label: 'counts',
      value: `${String(row.counts.activityIntervals)} intervals, ${String(row.counts.turns)} turns, ${String(row.counts.segments)} segments`,
    },
    { label: 'provenance', value: compactJson(row.rawSessionRecord.provenance) },
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
        { label: 'source locator', value: detail.session.sourceLocator ?? 'none' },
        { label: 'started', value: formatDate(detail.session.startedAt) },
        { label: 'last activity', value: formatDate(detail.session.lastActivityAt) },
        { label: 'ended', value: formatDate(detail.session.endedAt) },
        { label: 'metadata', value: compactJson(detail.session.metadata) },
        { label: 'provenance', value: compactJson(detail.session.provenance) },
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
        { label: 'metadata', value: compactJson(detail.authorUser.metadata) },
      ],
      options,
    ),
    recordBlock(
      'Source binding',
      [
        { label: 'source', value: detail.sourceBinding.sourceUri },
        { label: 'type', value: detail.sourceBinding.sourceType },
        { label: 'enabled', value: String(detail.sourceBinding.enabled) },
        { label: 'metadata', value: compactJson(detail.sourceBinding.config) },
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
          { label: 'started', value: interval.activityInterval.startedAt },
          { label: 'ended', value: formatDate(interval.activityInterval.endedAt) },
          { label: 'settled', value: formatDate(interval.activityInterval.settledAt) },
          { label: 'settlement', value: interval.activityInterval.settlementReason ?? 'none' },
          { label: 'metadata', value: compactJson(interval.activityInterval.metadata) },
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
  record: RawSessionRecordMetadata,
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
      { label: 'locator', value: record.sourceLocator ?? 'none' },
      { label: 'captured', value: record.capturedAt },
      {
        label: 'content',
        value: `${record.contentType}, ${String(record.contentBytes ?? 0)} bytes`,
      },
      { label: 'hash', value: record.contentHash },
      { label: 'metadata', value: compactJson(record.metadata) },
      { label: 'provenance', value: compactJson(record.provenance) },
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
  record: RawSessionRecordMetadata | null | undefined,
): record is RawSessionRecordMetadata & {
  rawBodyExposure: NonNullable<RawSessionRecordMetadata['rawBodyExposure']>;
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
      { label: 'parts', value: compactJson(turn.contentParts) },
      {
        label: 'raw events',
        value: turn.rawEventIds.length === 0 ? 'none' : turn.rawEventIds.join(', '),
      },
      { label: 'raw span', value: compactJson(turn.rawSpan) },
      { label: 'metadata', value: compactJson(turn.metadata) },
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
      { label: 'snippet', value: segment.snippet === null ? 'none' : segment.snippet },
      { label: 'text', value: truncate(segment.searchText, 280) },
      { label: 'metadata', value: compactJson(segment.metadata) },
    ],
    options,
  );
}

function truncateState(value: boolean): string {
  return value ? 'truncated' : 'complete';
}
