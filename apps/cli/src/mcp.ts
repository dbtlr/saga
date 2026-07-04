import {
  expandRecallContext,
  listRecentSessionRecords,
  makeDatabase,
  redactAgentFacingSessionValue,
  searchSessionRecall,
} from '@saga/db';
import type {
  DatabaseService,
  RecallContextExpansion,
  RecallSearchInput,
  RecallSearchResult,
  RecallSegmentMatch,
  RecentSessionRecord,
} from '@saga/db';
import { createSagaMcpServer } from '@saga/mcp';
import type {
  GetSessionContextInput,
  JsonRpcRequest,
  ListRecentSessionsInput,
  SearchSessionsInput,
} from '@saga/mcp';
import { loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { findProjectRoot, readBindingFile } from './init.js';
import {
  RECALL_EMBEDDING_NOT_ATTEMPTED,
  formatRecallSearchPosture,
  resolveRecallSearchEmbedding,
} from './recall.js';
import type { RecallSearchPosture, ResolvedRecallEmbedding } from './recall.js';
import type { RenderOptions } from './render.js';

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

function pruneBookkeepingBlobs(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !SESSION_BOOKKEEPING_BLOB_KEYS.has(key)),
  );
}

function pruneMetadataBlobs<T extends { metadata: Record<string, unknown> }>(value: T): T {
  return { ...value, metadata: pruneBookkeepingBlobs(value.metadata) };
}

function compactRecentSessionRecord(entry: RecentSessionRecord): RecentSessionRecord {
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

function compactRecallSearchResult(result: RecallSearchResult): RecallSearchResult {
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

function compactRecallContextExpansion(context: RecallContextExpansion): RecallContextExpansion {
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

export async function runMcpCommand(
  _args: readonly string[],
  _options: RenderOptions,
  write: (text: string) => void,
  stdin: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string | undefined> {
  const server = createProjectMcpServer();
  for await (const line of readJsonLines(stdin)) {
    try {
      const response = await server.handle(parseJsonRpcRequest(line));
      if (response !== undefined) {
        write(JSON.stringify(response));
      }
    } catch (error) {
      write(JSON.stringify(jsonRpcInputError(error)));
    }
  }
  return undefined;
}

export type ProjectSessionSearchDependencies = {
  cwd?: string | undefined;
  resolveRecallEmbedding?: ((query: string) => Promise<ResolvedRecallEmbedding>) | undefined;
  searchRecall?: ((input: RecallSearchInput) => Promise<RecallSearchResult>) | undefined;
};

export function createProjectMcpServer(options: ProjectSessionSearchDependencies = {}) {
  const cwd = options.cwd;
  return createSagaMcpServer({
    getSessionContext: (input) => getProjectSessionContext(input, cwd === undefined ? {} : { cwd }),
    listRecentSessions: (input) =>
      listProjectRecentSessions(input, cwd === undefined ? {} : { cwd }),
    searchSessions: (input) => searchProjectSessions(input, options),
  });
}

export async function listProjectRecentSessions(
  input: ListRecentSessionsInput,
  options: { cwd?: string } = {},
) {
  return withProjectDatabase(options, async (service, workspaceId) => {
    const sessions = await Effect.runPromise(
      listRecentSessionRecords(service, {
        activeOnly: input.activeOnly,
        harness: input.harness,
        limit: input.limit,
        workspaceId,
      }),
    );
    return {
      markdown: renderRecentSessionsMarkdown(sessions),
      sessions: sessions.map((session) =>
        redactMcpStructuredOutput(compactRecentSessionRecord(session)),
      ),
    };
  });
}

export async function searchProjectSessions(
  input: SearchSessionsInput,
  options: ProjectSessionSearchDependencies = {},
) {
  // Validate the workspace binding before any embedding resolution so a request that is
  // going to fail cannot cause query egress, matching the CLI ordering.
  const { workspaceId } = loadProjectWorkspace(options);
  // Query embedding resolution shares the CLI gate (resolveRecallSearchEmbedding): the query
  // text never reaches a remote provider unless installation policy enables remote embeddings
  // (ADR 0032). Never pass RecallSearchInput.embeddingProvider here — it is an ungated egress
  // seam.
  const resolved = await resolveMcpSearchEmbedding(input.query, options);
  const queryEmbedding = resolved.posture.mode === 'vector' ? resolved.queryEmbedding : undefined;
  const searchInput: RecallSearchInput = {
    activityIntervalId: input.activityIntervalId,
    limit: input.limit,
    minTrigramScore: input.minTrigramScore,
    query: input.query,
    queryEmbedding,
    rawSessionRecordId: input.rawSessionRecordId,
    sessionId: input.sessionId,
    workspaceId,
  };
  const recall =
    options.searchRecall === undefined
      ? await withProjectDatabase(options, async (service) =>
          Effect.runPromise(searchSessionRecall(service, searchInput)),
        )
      : await options.searchRecall(searchInput);
  return {
    markdown: renderSessionSearchMarkdown(recall, resolved.posture),
    recall: redactMcpStructuredOutput({
      ...compactRecallSearchResult(recall),
      search: resolved.posture,
    }),
  };
}

async function resolveMcpSearchEmbedding(
  query: string,
  options: ProjectSessionSearchDependencies,
): Promise<ResolvedRecallEmbedding> {
  if (options.resolveRecallEmbedding !== undefined) {
    return options.resolveRecallEmbedding(query);
  }
  if (options.searchRecall !== undefined) {
    return RECALL_EMBEDDING_NOT_ATTEMPTED;
  }
  return resolveRecallSearchEmbedding(query);
}

export async function getProjectSessionContext(
  input: GetSessionContextInput,
  options: { cwd?: string } = {},
) {
  return withProjectDatabase(options, async (service, workspaceId) => {
    const context = await Effect.runPromise(
      expandRecallContext(service, {
        afterTurns: input.afterTurns,
        beforeTurns: input.beforeTurns,
        segmentId: input.segmentId,
        windowTurns: input.windowTurns,
        workspaceId,
      }),
    );
    return {
      context: redactMcpStructuredOutput(compactRecallContextExpansion(context)),
      markdown: renderSessionContextMarkdown(context),
    };
  });
}

function loadProjectWorkspace(options: { cwd?: string | undefined }): {
  projectRoot: string;
  workspaceId: string;
} {
  const projectRoot = findProjectRoot(options.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error('workspace binding is missing; run saga init');
  }
  return { projectRoot, workspaceId: binding.workspace.id };
}

async function withProjectDatabase<T>(
  options: { cwd?: string | undefined },
  runWithService: (service: DatabaseService, workspaceId: string) => Promise<T>,
): Promise<T> {
  const { projectRoot, workspaceId } = loadProjectWorkspace(options);
  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    return await runWithService(service, workspaceId);
  } finally {
    await Effect.runPromise(service.close());
  }
}

function renderRecentSessionsMarkdown(sessions: readonly RecentSessionRecord[]): string {
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

function renderSessionSearchMarkdown(
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

function renderSessionContextMarkdown(result: RecallContextExpansion): string {
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

async function* readJsonLines(stdin: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== '') {
        yield trimmed;
      }
    }
  }
  const trimmed = buffer.trim();
  if (trimmed !== '') {
    yield trimmed;
  }
}

function parseJsonRpcRequest(line: string): JsonRpcRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    throw new Error('expected a JSON-RPC 2.0 request object');
  }
  if (
    parsed.id !== undefined &&
    typeof parsed.id !== 'string' &&
    typeof parsed.id !== 'number' &&
    parsed.id !== null
  ) {
    throw new Error('JSON-RPC request id must be a string, number, or null');
  }
  return {
    id: parsed.id,
    jsonrpc: '2.0',
    method: parsed.method,
    params: parsed.params,
  };
}

function jsonRpcInputError(error: unknown) {
  return {
    error: {
      code: error instanceof SyntaxError ? -32700 : -32600,
      message: error instanceof Error ? error.message : String(error),
    },
    id: null,
    jsonrpc: '2.0',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
