// STRANGLER TWIN (SGA-238, reconciled at SGA-249): this module is a deliberate
// duplicate of the MCP presentation layer that today lives inline in
// apps/cli/src/mcp.ts (the stdio MCP server). apps/service must not depend on
// apps/cli, so the compaction, redaction, and markdown-render helpers are copied
// here rather than imported across the app boundary. The service MCP and the
// stdio MCP therefore run structurally identical presentation code against the
// same @saga/db result shapes — the parity contract (mcp.postgres.test.ts) pins
// them byte-for-byte. When the CLI stdio server is retired (SGA-249) its copy is
// deleted and this becomes the sole home. Helpers that already live @saga/db-side
// (redactAgentFacingSessionValue) are reused from there, not re-copied.

import { redactAgentFacingSessionValue } from '@saga/db';
import type {
  RecallContextExpansion,
  RecallSearchResult,
  RecallSegmentMatch,
  RecentSessionRecord,
} from '@saga/db';

// The unbounded internal bookkeeping blobs inside session read-model `metadata`
// records (SGA-200): lifecycle event ledgers, normalization spans (which embed the
// harness system prompt), subagent evidence, and per-turn context snapshots weighed
// megabytes per MCP response. They are pruned at the session projections below —
// never via the generic key strip — so user-supplied import annotations and
// transcript-borne content fields keep flowing through structured output.
const SESSION_BOOKKEEPING_BLOB_KEYS = new Set([
  'lifecycleEvents',
  'normalization',
  'subagentEvidence',
  'turnContexts',
]);

// The service MCP recall path is LEXICAL-ONLY for now (SGA-238): vector query
// egress is deferred to a later slice, so the posture is a fixed lexical stance
// rather than the CLI's env/policy-resolved posture. The parity test drives the
// stdio server with this same posture so the presentation output stays comparable.
export type RecallSearchMode = 'vector' | 'lexical' | 'degraded';

export type RecallSearchPosture = {
  mode: RecallSearchMode;
  reason?: string;
  detail?: string;
};

export const SERVICE_LEXICAL_POSTURE: RecallSearchPosture = {
  detail: 'vector recall query egress is deferred to a later slice',
  mode: 'lexical',
  reason: 'service-lexical-only',
};

export function formatRecallSearchPosture(posture: RecallSearchPosture): string {
  return posture.reason === undefined ? posture.mode : `${posture.mode} (${posture.reason})`;
}

function pruneBookkeepingBlobs(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !SESSION_BOOKKEEPING_BLOB_KEYS.has(key)),
  );
}

function pruneMetadataBlobs<T extends { metadata: Record<string, unknown> }>(value: T): T {
  return { ...value, metadata: pruneBookkeepingBlobs(value.metadata) };
}

export function compactRecentSessionRecord(entry: RecentSessionRecord): RecentSessionRecord {
  return {
    ...entry,
    activityInterval:
      entry.activityInterval === null ? null : pruneMetadataBlobs(entry.activityInterval),
    authorUser: pruneMetadataBlobs(entry.authorUser),
    rawSessionRecord: pruneMetadataBlobs(entry.rawSessionRecord),
    session: pruneMetadataBlobs(entry.session),
  };
}

function compactRecallSession(
  session: RecallSegmentMatch['session'],
): RecallSegmentMatch['session'] {
  return { ...pruneMetadataBlobs(session), authorUser: pruneMetadataBlobs(session.authorUser) };
}

function compactRecallMatch(match: RecallSegmentMatch): RecallSegmentMatch {
  return {
    ...match,
    activityInterval: pruneMetadataBlobs(match.activityInterval),
    rawSessionRecord: pruneMetadataBlobs(match.rawSessionRecord),
    session: compactRecallSession(match.session),
  };
}

function compactRecallIntervalGroup(
  group: RecallSearchResult['intervals'][number],
): RecallSearchResult['intervals'][number] {
  return {
    ...group,
    activityInterval: pruneMetadataBlobs(group.activityInterval),
    matches: group.matches.map(compactRecallMatch),
  };
}

export function compactRecallSearchResult(result: RecallSearchResult): RecallSearchResult {
  return {
    ...result,
    intervals: result.intervals.map(compactRecallIntervalGroup),
    sessions: result.sessions.map((group) => ({
      activityIntervals: group.activityIntervals.map(compactRecallIntervalGroup),
      matches: group.matches.map(compactRecallMatch),
      session: compactRecallSession(group.session),
    })),
  };
}

export function compactRecallContextExpansion(
  context: RecallContextExpansion,
): RecallContextExpansion {
  return {
    ...context,
    activityInterval: pruneMetadataBlobs(context.activityInterval),
    rawSessionRecord: pruneMetadataBlobs(context.rawSessionRecord),
    session: compactRecallSession(context.session),
    turns: context.turns.map((turn) => ({
      ...pruneMetadataBlobs(turn),
      segments: turn.segments.map((segment) => pruneMetadataBlobs(segment)),
    })),
  };
}

export function renderRecentSessionsMarkdown(sessions: readonly RecentSessionRecord[]): string {
  if (sessions.length === 0) {
    return '# Recent Saga Sessions\n\nNo recent sessions found.';
  }

  return [
    '# Recent Saga Sessions',
    '',
    ...sessions.flatMap((entry, index) => [
      `## Session ${String(index + 1)}`,
      '',
      `- Session: ${entry.session.id}`,
      `- Raw record: ${entry.rawSessionRecord.id} (snapshot ${String(entry.rawSessionRecord.snapshotOrdinal)}, ${entry.rawSessionRecord.status}, active ${String(entry.rawSessionRecord.isActive)})`,
      `- Title: ${entry.session.title ?? 'none'}`,
      `- Harness: ${entry.session.harness} (harness session: ${entry.session.harnessSessionId ?? 'none'})`,
      `- Model: ${entry.session.model ?? 'none'}`,
      `- Host user: ${entry.authorUser.handle} (${entry.authorUser.identitySource})`,
      `- Status: ${entry.session.status}`,
      `- Started: ${formatDate(entry.session.startedAt)}`,
      `- Last activity: ${formatDate(entry.session.lastActivityAt)}`,
      `- Captured: ${formatDate(entry.rawSessionRecord.capturedAt)}`,
      `- Counts: ${String(entry.counts.turns)} turns, ${String(entry.counts.segments)} segments, ${String(entry.counts.rawSessionRecords)} raw records, ${String(entry.counts.activityIntervals)} Activity Intervals`,
      `- Activity Interval: ${entry.activityInterval === null ? 'none' : `${entry.activityInterval.id} (ordinal ${String(entry.activityInterval.ordinal)}, ${entry.activityInterval.status})`}`,
      `- Source: ${formatSourceBinding(entry.sourceBinding)}`,
      `- Provenance: session=${compactSafeJson(entry.session.provenance)} raw=${compactSafeJson(entry.rawSessionRecord.provenance)}`,
      '',
    ]),
  ].join('\n');
}

export function renderSessionSearchMarkdown(
  result: RecallSearchResult,
  posture: RecallSearchPosture,
): string {
  const lines = [
    '# Saga Session Search',
    '',
    `- Query: ${result.query}`,
    `- Workspace: ${result.workspaceId}`,
    `- Mode: ${formatRecallSearchPosture(posture)}`,
    `- Matches: ${String(result.matchCount)}`,
    `- Searched: ${result.searchedAt}`,
  ];

  if (result.matchCount === 0) {
    return [...lines, '', 'No matching session segments found.'].join('\n');
  }

  let matchIndex = 1;
  for (const sessionGroup of result.sessions) {
    lines.push(
      '',
      `## Session ${sessionGroup.session.id}`,
      '',
      `- Title: ${sessionGroup.session.title ?? 'none'}`,
      `- Harness: ${sessionGroup.session.harness} (harness session: ${sessionGroup.session.harnessSessionId ?? 'none'})`,
      `- Model: ${sessionGroup.session.model ?? 'none'}`,
      `- Host user: ${sessionGroup.session.authorUser.handle} (${sessionGroup.session.authorUser.identitySource})`,
      `- Status: ${sessionGroup.session.status}`,
      `- Last activity: ${formatDate(sessionGroup.session.lastActivityAt)}`,
      `- Provenance: ${compactSafeJson(sessionGroup.session.provenance)}`,
    );

    for (const intervalGroup of sessionGroup.activityIntervals) {
      lines.push(
        '',
        `### Activity Interval ${String(intervalGroup.activityInterval.ordinal)}`,
        '',
        `- ID: ${intervalGroup.activityInterval.id}`,
        `- Status: ${intervalGroup.activityInterval.status}`,
        `- Started: ${formatDate(intervalGroup.activityInterval.startedAt)}`,
        `- Ended: ${formatDate(intervalGroup.activityInterval.endedAt)}`,
      );

      for (const match of intervalGroup.matches) {
        lines.push('', renderSessionMatchMarkdown(match, matchIndex));
        matchIndex += 1;
      }
    }
  }

  return lines.join('\n');
}

function renderSessionMatchMarkdown(match: RecallSegmentMatch, matchIndex: number): string {
  return [
    `#### Match ${String(matchIndex)}`,
    '',
    `- Segment: ${match.segment.id} (${match.segment.segmentKind}, ordinal ${String(match.segment.ordinal)})`,
    `- Turn: ${match.turn.id} (ordinal ${String(match.turn.ordinal)}, ${match.turn.role})`,
    `- Raw record: ${match.rawSessionRecord.id} (snapshot ${String(match.rawSessionRecord.snapshotOrdinal)}, ${match.rawSessionRecord.status})`,
    `- Scores: ${formatScores(match.scores)}`,
    `- Tokens: ${formatRange(match.segment.tokenStart, match.segment.tokenEnd)}`,
    `- Characters: ${formatRange(match.segment.charStart, match.segment.charEnd)}`,
    `- Source: ${formatSourceBinding(match.sourceBinding)}`,
    `- Provenance: raw=${compactSafeJson(match.rawSessionRecord.provenance)}`,
    '',
    'Retrieved Content:',
    '',
    redactMcpTextOutput(stripSearchMarkup(match.snippet)),
  ].join('\n');
}

export function renderSessionContextMarkdown(result: RecallContextExpansion): string {
  const lines = [
    '# Saga Session Context',
    '',
    `- Anchor segment: ${result.anchor.segment.id}`,
    `- Anchor turn: ${result.anchor.turn.id}`,
    `- Window: ${String(result.beforeTurns)} turns before / ${String(result.afterTurns)} turns after`,
    `- Session: ${result.session.id}`,
    `- Activity Interval: ${result.activityInterval.id} (ordinal ${String(result.activityInterval.ordinal)})`,
    `- Raw record: ${result.rawSessionRecord.id} (snapshot ${String(result.rawSessionRecord.snapshotOrdinal)}, ${result.rawSessionRecord.status})`,
    `- Harness: ${result.session.harness} (harness session: ${result.session.harnessSessionId ?? 'none'})`,
    `- Model: ${result.session.model ?? 'none'}`,
    `- Host user: ${result.session.authorUser.handle} (${result.session.authorUser.identitySource})`,
    `- Source: ${formatSourceBinding(result.sourceBinding)}`,
    `- Provenance: session=${compactSafeJson(result.session.provenance)} raw=${compactSafeJson(result.rawSessionRecord.provenance)}`,
  ];

  if (result.warnings.length > 0) {
    lines.push('', '## Warnings');
    for (const warning of result.warnings) {
      const turnRef = warning.turnId === undefined ? '' : ` (turn ${warning.turnId})`;
      lines.push(`- ${warning.kind}${turnRef}: ${warning.detail}`);
    }
  }

  lines.push('', '## Retrieved Context');

  for (const turn of result.turns) {
    lines.push(
      '',
      `### Turn ${String(turn.ordinal)} ${turn.role}`,
      '',
      `- Turn: ${turn.id}`,
      `- Actor: ${turn.actorKind}:${turn.actorLabel ?? 'none'}`,
      `- Model: ${turn.model ?? 'none'}`,
      `- Started: ${formatDate(turn.startedAt)}`,
      `- Ended: ${formatDate(turn.endedAt)}`,
      `- Raw events: ${turn.rawEventIds.length === 0 ? 'none' : turn.rawEventIds.join(', ')}`,
      `- Raw span: ${compactSafeJson(turn.rawSpan)}`,
    );

    for (const segment of turn.segments) {
      const anchor = segment.id === result.anchor.segment.id ? ' anchor' : '';
      lines.push(
        '',
        `#### Segment ${String(segment.ordinal)}${anchor}`,
        '',
        `- Segment: ${segment.id}`,
        `- Kind: ${segment.segmentKind}`,
        `- Tokens: ${formatRange(segment.tokenStart, segment.tokenEnd)}`,
        `- Characters: ${formatRange(segment.charStart, segment.charEnd)}`,
        `- Snippet: ${segment.snippet === null ? 'none' : redactMcpTextOutput(segment.snippet)}`,
        '',
        'Text:',
        '',
        truncate(redactMcpTextOutput(segment.searchText), 1200),
      );
    }
  }

  return lines.join('\n');
}

export function redactMcpStructuredOutput(value: unknown): unknown {
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactMcpStructuredOutput(entry));
  }
  if (typeof value === 'string') {
    return redactAgentFacingString(value);
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isUnsafeMcpStructuredKey(key)) {
      continue;
    }
    redacted[key] = redactMcpStructuredOutput(entry);
  }
  return redacted;
}

function isUnsafeMcpStructuredKey(key: string): boolean {
  return key === 'config' || key.toLowerCase().includes('sourcelocator');
}

function formatSourceBinding(sourceBinding: {
  displayName?: string | null | undefined;
  enabled: boolean;
  id: string;
  sourceType: string;
}): string {
  const display = sourceBinding.displayName === undefined ? undefined : sourceBinding.displayName;
  return `${sourceBinding.sourceType} binding=${sourceBinding.id} enabled=${String(sourceBinding.enabled)}${display === null || display === undefined ? '' : ` display=${display}`}`;
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

function formatScore(value: number): string {
  return value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '');
}

function formatDate(value: Date | string | null): string {
  if (value === null) {
    return 'none';
  }
  return value instanceof Date ? value.toISOString() : value;
}

function formatRange(start: number | null, end: number | null): string {
  if (start === null && end === null) {
    return 'none';
  }
  return `${start === null ? '?' : String(start)}..${end === null ? '?' : String(end)}`;
}

function compactSafeJson(value: unknown): string {
  const json = JSON.stringify(redactAgentFacingSessionValue(value));
  return json === undefined ? 'undefined' : truncate(json, 220);
}

function redactMcpTextOutput(value: string): string {
  return redactAgentFacingString(value);
}

function redactAgentFacingString(value: string): string {
  const redacted = redactAgentFacingSessionValue(value);
  return typeof redacted === 'string' ? redacted : value;
}

function stripSearchMarkup(value: string): string {
  return value.replaceAll(/<\/?b>/g, '');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
