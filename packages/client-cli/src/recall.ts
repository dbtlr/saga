import type {
  GetSessionContextRequest,
  RecallContextExpansion,
  RecallExpandedSegment,
  RecallExpandedTurn,
  RecallExpansionWarning,
  RecallRequest,
  RecallSearchPosture,
  RecallSearchResult,
  RecallSegmentMatch,
} from '@saga/api-client';

import {
  firstFlag,
  parseLocalOptions,
  parseNonNegativeIntegerFlag,
  parsePositiveIntegerFlag,
  parseScoreFlag,
} from './command-args.js';
import { resolveClient, resolveWorkspaceId } from './command-context.js';
import type { ClientCommandContext } from './command-context.js';
import {
  compactJson,
  formatDate,
  formatRange,
  formatScore,
  stripTsHeadline,
  truncate,
} from './command-format.js';
import { formatCommandOutput } from './output.js';
import { recordBlock, separator } from './render.js';
import type { RenderOptions } from './render.js';

// The service resolves vector-vs-lexical from installation policy (SGA-253), so
// the client forwards intent rather than deciding: `--no-embeddings` forces
// `mode:'lexical'`, `--vector-candidates` bounds the vector candidate set, and the
// default lets the service choose. The effective mode comes back on the response.
const SEARCH_FLAGS_WITH_VALUES = new Set([
  'activity',
  'activity-interval',
  'activity-interval-id',
  'limit',
  'min-trigram',
  'raw',
  'raw-record',
  'raw-session-record',
  'raw-session-record-id',
  'session',
  'session-id',
  'vector-candidates',
  'workspace',
  'workspace-id',
]);
const SEARCH_BOOLEAN_FLAGS = new Set(['no-embeddings']);
const SHOW_FLAGS_WITH_VALUES = new Set(['after', 'before', 'window', 'workspace', 'workspace-id']);
const SHOW_BOOLEAN_FLAGS = new Set<string>();

export async function runRecallCommand(
  args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext = {},
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === 'search') {
    return searchRecallCommand(args.slice(1), options, context);
  }
  if (subcommand === 'show') {
    return showRecallCommand(args.slice(1), options, context);
  }
  throw new Error(`recall ${subcommand ?? ''} is not implemented yet`.trim());
}

async function searchRecallCommand(
  args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: SEARCH_BOOLEAN_FLAGS,
    flagsWithValues: SEARCH_FLAGS_WITH_VALUES,
    noun: 'recall',
  });
  const query = parsed.positionals.join(' ').trim();
  if (query === '') {
    throw new Error('recall search requires a query: saga recall search <query>');
  }

  const workspaceId = resolveWorkspaceId(parsed.flags, context);
  const request: RecallRequest = {
    activityIntervalId: firstFlag(parsed.flags, [
      'activity-interval-id',
      'activity-interval',
      'activity',
    ]),
    limit: parsePositiveIntegerFlag(parsed.flags.limit, 'limit'),
    minTrigramScore: parseScoreFlag(parsed.flags['min-trigram'], 'min-trigram'),
    // `--no-embeddings` forces lexical (suppressing query-embedding egress); otherwise
    // the mode is left unset so the service resolves vector-vs-lexical from policy.
    ...(parsed.booleans.has('no-embeddings') ? { mode: 'lexical' as const } : {}),
    query,
    rawSessionRecordId: firstFlag(parsed.flags, [
      'raw-session-record-id',
      'raw-session-record',
      'raw-record',
      'raw',
    ]),
    sessionId: firstFlag(parsed.flags, ['session-id', 'session']),
    vectorCandidateLimit: parsePositiveIntegerFlag(
      parsed.flags['vector-candidates'],
      'vector-candidates',
    ),
    workspaceId,
  };

  const result = await resolveClient(context).recall(request);
  // The service reports the mode it actually ran (vector/lexical/degraded) on the
  // response; render and echo that rather than assuming a fixed stance. Fall back to
  // a bare lexical posture if the field is absent — a client may out-run its service
  // across a version skew, and a missing posture must not crash the whole command.
  const posture: RecallSearchPosture = result.search ?? { mode: 'lexical' };

  return formatCommandOutput(
    {
      id: result.sessions
        .flatMap((group) => group.matches.map((match) => match.segment.id))
        .join('\n'),
      records: renderRecallSearch(result, posture, options),
      value: { ...result, search: posture },
    },
    options.format,
  );
}

async function showRecallCommand(
  args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: SHOW_BOOLEAN_FLAGS,
    flagsWithValues: SHOW_FLAGS_WITH_VALUES,
    noun: 'recall',
  });
  const segmentId = parsed.positionals[0];
  if (segmentId === undefined) {
    throw new Error('recall show requires a segment id: saga recall show <segment-id>');
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`recall show received unexpected argument: ${parsed.positionals[1]}`);
  }

  const request: GetSessionContextRequest = {
    ...parseContextWindowFlags(parsed.flags),
    workspaceId: resolveWorkspaceId(parsed.flags, context),
  };
  const result = await resolveClient(context).getSessionContext(segmentId, request);

  return formatCommandOutput(
    {
      id: result.anchor.segment.id,
      records: renderRecallContext(result, options),
      value: result,
    },
    options.format,
  );
}

export function formatRecallSearchPosture(posture: RecallSearchPosture): string {
  return posture.reason === undefined ? posture.mode : `${posture.mode} (${posture.reason})`;
}

function renderRecallSearch(
  result: RecallSearchResult,
  posture: RecallSearchPosture,
  options: RenderOptions,
): string {
  const blocks = [
    recordBlock(
      'Recall Search',
      [
        { label: 'query', value: result.query },
        { label: 'mode', value: formatRecallSearchPosture(posture) },
        { label: 'workspace', value: result.workspaceId },
        { label: 'matches', value: String(result.matchCount) },
        { label: 'searched', value: result.searchedAt },
      ],
      options,
    ),
  ];

  if (result.matchCount === 0) {
    blocks.push(recordBlock('Matches', [{ label: 'segments', value: 'none' }], options));
    return blocks.join(`\n${separator(options)}\n`);
  }

  let matchIndex = 1;
  for (const sessionGroup of result.sessions) {
    blocks.push(
      recordBlock(
        'Session',
        [
          { label: 'session', value: sessionGroup.session.id },
          { label: 'title', value: sessionGroup.session.title ?? 'none' },
          { label: 'harness', value: sessionGroup.session.harness },
          { label: 'harness session', value: sessionGroup.session.harnessSessionId ?? 'none' },
          { label: 'model', value: sessionGroup.session.model ?? 'none' },
          { label: 'host-user', value: sessionGroup.session.authorUser.handle },
          { label: 'source binding', value: sessionGroup.session.sourceBindingId },
          { label: 'last activity', value: formatDate(sessionGroup.session.lastActivityAt) },
          { label: 'provenance', value: compactJson(sessionGroup.session.provenance) },
        ],
        options,
      ),
    );

    for (const intervalGroup of sessionGroup.activityIntervals) {
      blocks.push(
        recordBlock(
          `Activity Interval ${String(intervalGroup.activityInterval.ordinal)}`,
          [
            { label: 'id', value: intervalGroup.activityInterval.id },
            { label: 'status', value: intervalGroup.activityInterval.status },
            { label: 'started', value: formatDate(intervalGroup.activityInterval.startedAt) },
            { label: 'ended', value: formatDate(intervalGroup.activityInterval.endedAt) },
            { label: 'matches', value: String(intervalGroup.matches.length) },
          ],
          options,
        ),
      );

      for (const match of intervalGroup.matches) {
        blocks.push(renderMatch(match, matchIndex, options));
        matchIndex += 1;
      }
    }
  }

  return blocks.join(`\n${separator(options)}\n`);
}

function renderMatch(
  match: RecallSegmentMatch,
  matchIndex: number,
  options: RenderOptions,
): string {
  return recordBlock(
    `Match ${String(matchIndex)}`,
    [
      { label: 'segment', value: match.segment.id },
      { label: 'turn', value: `${String(match.turn.ordinal)} ${match.turn.role} ${match.turn.id}` },
      { label: 'raw record', value: match.rawSessionRecord.id },
      { label: 'kind', value: match.segment.segmentKind },
      { label: 'scores', value: formatScores(match.scores) },
      { label: 'tokens', value: formatRange(match.segment.tokenStart, match.segment.tokenEnd) },
      { label: 'chars', value: formatRange(match.segment.charStart, match.segment.charEnd) },
      { label: 'snippet', value: stripTsHeadline(match.snippet) },
      { label: 'raw provenance', value: compactJson(match.rawSessionRecord.provenance) },
      { label: 'source', value: match.sourceBinding.sourceUri },
      { label: 'source type', value: match.sourceBinding.sourceType },
    ],
    options,
  );
}

function renderRecallContext(result: RecallContextExpansion, options: RenderOptions): string {
  const blocks = [
    recordBlock(
      'Recall Context',
      [
        { label: 'workspace', value: result.workspaceId },
        { label: 'window', value: formatContextWindow(result) },
        { label: 'anchor segment', value: result.anchor.segment.id },
        { label: 'anchor turn', value: result.anchor.turn.id },
        { label: 'session', value: result.session.id },
        { label: 'Activity Interval', value: result.activityInterval.id },
        { label: 'raw record', value: result.rawSessionRecord.id },
      ],
      options,
    ),
    recordBlock(
      'Session',
      [
        { label: 'title', value: result.session.title ?? 'none' },
        { label: 'harness', value: result.session.harness },
        { label: 'harness session', value: result.session.harnessSessionId ?? 'none' },
        { label: 'model', value: result.session.model ?? 'none' },
        { label: 'host-user', value: result.session.authorUser.handle },
        { label: 'status', value: result.session.status },
        { label: 'started', value: formatDate(result.session.startedAt) },
        { label: 'last activity', value: formatDate(result.session.lastActivityAt) },
        { label: 'provenance', value: compactJson(result.session.provenance) },
      ],
      options,
    ),
    recordBlock(
      'Source',
      [
        { label: 'source binding', value: result.sourceBinding.id },
        { label: 'source', value: result.sourceBinding.sourceUri },
        { label: 'type', value: result.sourceBinding.sourceType },
        { label: 'display', value: result.sourceBinding.displayName ?? 'none' },
        { label: 'enabled', value: String(result.sourceBinding.enabled) },
      ],
      options,
    ),
    recordBlock(
      'Raw Session Record',
      [
        { label: 'id', value: result.rawSessionRecord.id },
        { label: 'snapshot', value: String(result.rawSessionRecord.snapshotOrdinal) },
        { label: 'active', value: String(result.rawSessionRecord.isActive) },
        { label: 'status', value: result.rawSessionRecord.status },
        { label: 'harness', value: result.rawSessionRecord.harness },
        { label: 'harness session', value: result.rawSessionRecord.harnessSessionId ?? 'none' },
        { label: 'captured', value: formatDate(result.rawSessionRecord.capturedAt) },
        { label: 'content', value: result.rawSessionRecord.contentType },
        { label: 'hash', value: result.rawSessionRecord.contentHash },
        { label: 'provenance', value: compactJson(result.rawSessionRecord.provenance) },
      ],
      options,
    ),
    recordBlock(
      `Activity Interval ${String(result.activityInterval.ordinal)}`,
      [
        { label: 'id', value: result.activityInterval.id },
        { label: 'status', value: result.activityInterval.status },
        { label: 'started', value: formatDate(result.activityInterval.startedAt) },
        { label: 'ended', value: formatDate(result.activityInterval.endedAt) },
        { label: 'settled', value: formatDate(result.activityInterval.settledAt) },
        { label: 'settlement', value: result.activityInterval.settlementReason ?? 'none' },
      ],
      options,
    ),
  ];

  if (result.warnings.length > 0) {
    blocks.push(renderExpansionWarnings(result.warnings, options));
  }

  for (const turn of result.turns) {
    blocks.push(renderExpandedTurn(turn, result.anchor.segment.id, options));
  }

  return blocks.join(`\n${separator(options)}\n`);
}

function renderExpansionWarnings(
  warnings: readonly RecallExpansionWarning[],
  options: RenderOptions,
): string {
  return recordBlock(
    'Warnings',
    warnings.map((warning) => ({
      label: warning.kind,
      value:
        warning.turnId === undefined
          ? warning.detail
          : `${warning.detail} (turn ${warning.turnId})`,
    })),
    options,
  );
}

function renderExpandedTurn(
  turn: RecallExpandedTurn,
  anchorSegmentId: string,
  options: RenderOptions,
): string {
  const blocks = [
    recordBlock(
      `Turn ${String(turn.ordinal)}`,
      [
        { label: 'id', value: turn.id },
        { label: 'role', value: turn.role },
        { label: 'actor', value: `${turn.actorKind}:${turn.actorLabel ?? 'none'}` },
        { label: 'harness turn', value: turn.harnessTurnId ?? 'none' },
        { label: 'model', value: turn.model ?? 'none' },
        { label: 'started', value: formatDate(turn.startedAt) },
        { label: 'ended', value: formatDate(turn.endedAt) },
        { label: 'parts', value: compactJson(turn.contentParts) },
        {
          label: 'raw events',
          value: turn.rawEventIds.length === 0 ? 'none' : turn.rawEventIds.join(', '),
        },
        { label: 'raw span', value: compactJson(turn.rawSpan) },
      ],
      options,
    ),
  ];

  for (const segment of turn.segments) {
    blocks.push(renderExpandedSegment(segment, segment.id === anchorSegmentId, options));
  }

  return blocks.join(`\n${separator(options)}\n`);
}

function renderExpandedSegment(
  segment: RecallExpandedSegment,
  isAnchor: boolean,
  options: RenderOptions,
): string {
  return recordBlock(
    `Segment ${String(segment.ordinal)}${isAnchor ? ' anchor' : ''}`,
    [
      { label: 'id', value: segment.id },
      { label: 'kind', value: segment.segmentKind },
      { label: 'tokens', value: formatRange(segment.tokenStart, segment.tokenEnd) },
      { label: 'chars', value: formatRange(segment.charStart, segment.charEnd) },
      { label: 'snippet', value: segment.snippet === null ? 'none' : segment.snippet },
      { label: 'text', value: truncate(segment.searchText, 360) },
    ],
    options,
  );
}

function formatScores(scores: RecallSegmentMatch['scores']): string {
  const parts = [
    `combined ${formatScore(scores.combined)}`,
    `lexical ${formatScore(scores.lexical)}`,
    `trigram ${formatScore(scores.trigram)}`,
  ];
  if (scores.vector !== undefined) {
    parts.push(`vector ${formatScore(scores.vector)}`);
  }
  return parts.join(', ');
}

function formatContextWindow(result: RecallContextExpansion): string {
  const beforeTurns = result.beforeTurns ?? result.windowTurns;
  const afterTurns = result.afterTurns ?? result.windowTurns;
  return `${String(beforeTurns)} turns before / ${String(afterTurns)} turns after`;
}

function parseContextWindowFlags(
  flags: Record<string, string>,
): Pick<GetSessionContextRequest, 'afterTurns' | 'beforeTurns' | 'windowTurns'> {
  const windowTurns = parseNonNegativeIntegerFlag(flags.window, 'window');
  const before = parseNonNegativeIntegerFlag(flags.before, 'before');
  const after = parseNonNegativeIntegerFlag(flags.after, 'after');
  if (windowTurns === undefined && before === undefined && after === undefined) {
    return {};
  }
  if (before === undefined && after === undefined) {
    return { windowTurns };
  }
  return {
    afterTurns: after,
    beforeTurns: before,
    windowTurns,
  };
}
