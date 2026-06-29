import { and, asc, eq } from 'drizzle-orm';
import type { DatabaseService } from './database.js';
import {
  sessionSegments,
  sessionTurns,
  type NewSessionSegment,
  type SessionSegment,
  type SessionTurn,
} from './schema.js';

const DERIVER = 'session-segments-v1';
const MAX_UNSPLIT_TOKENS = 1_200;
const TARGET_CHUNK_TOKENS = 1_000;
const MIN_CHUNK_TOKENS = 800;
const CHUNK_OVERLAP_TOKENS = 125;
const SNIPPET_CHARS = 240;

type JsonRecord = Record<string, unknown>;

interface SegmentDraft {
  charEnd: number | null;
  charStart: number | null;
  metadata: JsonRecord;
  searchText: string;
  segmentKind: string;
  snippet: string | null;
  tokenEnd: number | null;
  tokenStart: number | null;
  turn: SessionTurn;
}

interface TextExtraction {
  contentPartTypes: string[];
  filters: FilterReason[];
  searchText: string;
  skippedPartCount: number;
}

interface FilterReason {
  partIndex: number;
  reason: string;
  type?: string | undefined;
}

interface ToolGroupContext {
  callId?: string | undefined;
  contentPartTypes: string[];
  filters: FilterReason[];
  memberCount: number;
  memberIndex: number;
  skippedPartCount: number;
  turns: readonly SessionTurn[];
}

interface ToolEvidence {
  callId: string;
  partType: 'tool_call' | 'tool_result';
}

export async function insertDerivedSessionSegments(
  tx: DatabaseService['db'],
  input: {
    rawSessionRecordId: string;
    sessionId: string;
    workspaceId: string;
  },
): Promise<void> {
  const turns = await selectSegmentSourceTurns(tx, input);
  const values = deriveSessionSegmentsFromTurns(turns);
  if (values.length === 0) return;
  await tx.insert(sessionSegments).values(values);
}

export async function sessionSegmentsAreCurrent(
  tx: DatabaseService['db'],
  input: {
    rawSessionRecordId: string;
    sessionId: string;
    workspaceId: string;
  },
): Promise<boolean> {
  const turns = await selectSegmentSourceTurns(tx, input);
  const expected = deriveSessionSegmentsFromTurns(turns);
  const actual = await tx
    .select()
    .from(sessionSegments)
    .where(
      and(
        eq(sessionSegments.sessionId, input.sessionId),
        eq(sessionSegments.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(asc(sessionSegments.ordinal));

  if (actual.length !== expected.length) return false;
  return expected.every((expectedSegment, index) =>
    segmentMatches(actual[index], expectedSegment, index),
  );
}

export function deriveSessionSegmentsFromTurns(turns: readonly SessionTurn[]): NewSessionSegment[] {
  const drafts: SegmentDraft[] = [];
  const toolGroups = buildToolGroupContexts(turns);

  for (const turn of turns) {
    drafts.push(...deriveDraftsForSingleTurn(turn, toolGroups.get(turn.id)));
  }

  return drafts.map((draft, ordinal) => ({
    activityIntervalId: draft.turn.activityIntervalId,
    charEnd: draft.charEnd,
    charStart: draft.charStart,
    metadata: draft.metadata,
    ordinal,
    rawSessionRecordId: draft.turn.rawSessionRecordId,
    searchText: draft.searchText,
    segmentKind: draft.segmentKind,
    sessionId: draft.turn.sessionId,
    snippet: draft.snippet,
    tokenEnd: draft.tokenEnd,
    tokenStart: draft.tokenStart,
    turnId: draft.turn.id,
    workspaceId: draft.turn.workspaceId,
  }));
}

async function selectSegmentSourceTurns(
  tx: DatabaseService['db'],
  input: {
    rawSessionRecordId: string;
    sessionId: string;
    workspaceId: string;
  },
): Promise<SessionTurn[]> {
  return tx
    .select()
    .from(sessionTurns)
    .where(
      and(
        eq(sessionTurns.rawSessionRecordId, input.rawSessionRecordId),
        eq(sessionTurns.sessionId, input.sessionId),
        eq(sessionTurns.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(asc(sessionTurns.ordinal));
}

function deriveDraftsForSingleTurn(turn: SessionTurn, group?: ToolGroupContext): SegmentDraft[] {
  const extraction = extractGroupSearchText([turn]);
  if (extraction.searchText === '') {
    if (extraction.skippedPartCount === 0 && extraction.contentPartTypes.length === 0) return [];
    return [buildSkippedDraft(turn, extraction, group)];
  }

  const baseKind = group === undefined ? 'turn' : toolGroupMemberKind(turn);
  const chunks = splitSearchText(extraction.searchText);
  return chunks.map((chunk, chunkIndex) => ({
    charEnd: chunk.charEnd,
    charStart: chunk.charStart,
    metadata: buildSegmentMetadata(group?.turns ?? [turn], turn, extraction, {
      charEnd: chunk.charEnd,
      charStart: chunk.charStart,
      chunkCount: chunks.length,
      chunkIndex,
      searchTextLength: extraction.searchText.length,
      tokenEnd: chunk.tokenEnd,
      tokenStart: chunk.tokenStart,
      toolGroup: group,
    }),
    searchText: chunk.text,
    segmentKind: chunks.length === 1 ? baseKind : `${baseKind}_chunk`,
    snippet: buildSnippet(chunk.text),
    tokenEnd: chunk.tokenEnd,
    tokenStart: chunk.tokenStart,
    turn,
  }));
}

function buildSkippedDraft(
  turn: SessionTurn,
  extraction: TextExtraction,
  group?: ToolGroupContext,
): SegmentDraft {
  return {
    charEnd: null,
    charStart: null,
    metadata: buildSkippedSegmentMetadata(group?.turns ?? [turn], turn, extraction, group),
    searchText: '',
    segmentKind: group === undefined ? 'turn_skipped' : 'tool_group_skipped',
    snippet: null,
    tokenEnd: null,
    tokenStart: null,
    turn,
  };
}

function toolGroupMemberKind(turn: SessionTurn): string {
  const parts = Array.isArray(turn.contentParts) ? turn.contentParts.map(asRecord) : [];
  if (parts.some((part) => readString(part.type) === 'tool_call')) return 'tool_group_call';
  if (parts.some((part) => readString(part.type) === 'tool_result')) return 'tool_group_result';
  return 'tool_group_member';
}

function extractGroupSearchText(turns: readonly SessionTurn[]): TextExtraction {
  const filters: FilterReason[] = [];
  const partTypes: string[] = [];
  let skippedPartCount = 0;
  const texts: string[] = [];
  let groupPartIndex = 0;

  for (const turn of turns) {
    const parts = Array.isArray(turn.contentParts) ? turn.contentParts : [];
    for (const part of parts) {
      const partRecord = asRecord(part);
      const partType = readString(partRecord.type) ?? 'unknown';
      partTypes.push(partType);

      const rawText = partToSearchText(partRecord);
      const filtered = filterSearchText(rawText);
      if (filtered.reason !== undefined) {
        filters.push({
          partIndex: groupPartIndex,
          reason: filtered.reason,
          type: partType,
        });
      }

      if (filtered.text === '') {
        skippedPartCount += 1;
      } else {
        texts.push(filtered.text);
      }
      groupPartIndex += 1;
    }
  }

  return {
    contentPartTypes: partTypes,
    filters,
    searchText: normalizeSearchText(texts.join('\n')),
    skippedPartCount,
  };
}

function partToSearchText(part: JsonRecord): string {
  const type = readString(part.type);
  if (type === 'tool_call') {
    return [
      readString(part.name),
      stringifyForSearch(part.arguments ?? part.input ?? part.action),
      stringifyForSearch(part.execution),
      stringifyForSearch(part.status),
      stringifyForSearch(part.tools),
    ]
      .filter((value) => value !== '')
      .join(' ');
  }

  if (type === 'tool_result') {
    return [
      readString(part.name),
      stringifyForSearch(part.output),
      stringifyForSearch(part.execution),
      stringifyForSearch(part.status),
      stringifyForSearch(part.tools),
    ]
      .filter((value) => value !== '')
      .join(' ');
  }

  if (typeof part.text === 'string') return part.text;
  if (typeof part.output === 'string') return part.output;
  if (typeof part.arguments === 'string') return part.arguments;
  return stringifyForSearch(part);
}

function filterSearchText(rawText: string): { reason?: string | undefined; text: string } {
  const withoutAnsi = rawText.replaceAll(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu'),
    '',
  );
  const withoutBoilerplate = withoutAnsi
    .split(/\r?\n/u)
    .filter((line) => !/^(Exit code:|Wall time:|Output:)\b/u.test(line.trim()))
    .join('\n');
  const text = withoutBoilerplate.trim();
  if (text === '') return { text: '' };

  const coarseReason = coarseFilterReason(text);
  if (coarseReason !== undefined) return { reason: coarseReason, text: '' };

  const structuredRedaction = redactStructuredSecrets(text);
  const candidateLines = structuredRedaction.text.split(/\r?\n/u);
  const redactedLines = candidateLines.filter((line) => !containsObviousSecret(line));
  if (redactedLines.length !== candidateLines.length) {
    return {
      reason: 'secret',
      text: normalizeSearchText(redactedLines.join('\n')),
    };
  }

  const normalized = normalizeSearchText(structuredRedaction.text);
  if (!/[A-Za-z0-9]/u.test(normalized)) return { text: '' };
  return {
    reason: structuredRedaction.redacted ? 'secret' : undefined,
    text: normalized,
  };
}

function coarseFilterReason(text: string): string | undefined {
  if (hasBinaryShape(text) || hasLargeBase64Blob(text)) return 'binary_or_base64';
  if (isHugeRawLog(text)) return 'huge_raw_log';
  if (isUnboundedDiff(text)) return 'unbounded_diff';
  if (isRepeatedGeneratedFile(text)) return 'repeated_generated_file';
  return undefined;
}

function hasBinaryShape(text: string): boolean {
  if (text.includes(String.fromCharCode(0))) return true;
  let controlCount = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code >= 1 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      controlCount += 1;
    }
  }
  return controlCount > 20 && controlCount / Math.max(text.length, 1) > 0.02;
}

function hasLargeBase64Blob(text: string): boolean {
  const compact = text.replaceAll(/\s+/gu, '');
  const whitespaceRatio = (text.match(/\s/gu)?.length ?? 0) / Math.max(text.length, 1);
  if (compact.length > 300 && whitespaceRatio < 0.02 && /^[A-Za-z0-9+/=]+$/u.test(compact)) {
    return true;
  }
  return /(?:[A-Za-z0-9+/]{80,}={0,2}\s*){3,}/u.test(text);
}

function isHugeRawLog(text: string): boolean {
  const lines = text.split(/\r?\n/u);
  if (text.length > 50_000 || lines.length > 800) return true;
  const logLikeLines = lines.filter((line) =>
    /^(?:\[[^\]]+\]|\d{4}-\d{2}-\d{2}[T ]|\w+:\s|at\s+\S+\s+\()/u.test(line.trim()),
  );
  return lines.length > 200 && logLikeLines.length / lines.length > 0.7;
}

function isUnboundedDiff(text: string): boolean {
  const lines = text.split(/\r?\n/u);
  const diffLines = lines.filter((line) =>
    /^(?:diff --git|index [a-f0-9]|@@ |\+\+\+ |--- |\+|-)/u.test(line),
  );
  return (lines.length > 220 || text.length > 20_000) && diffLines.length / lines.length > 0.35;
}

function isRepeatedGeneratedFile(text: string): boolean {
  if (text.length < 8_000) return false;
  if (
    /\b(?:generated|auto-generated|do not edit|routeTree\.gen|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)\b/iu.test(
      text,
    )
  ) {
    return true;
  }

  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length < 100) return false;
  return new Set(lines).size / lines.length < 0.25;
}

function containsObviousSecret(text: string): boolean {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\b["']?\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"',}\]]{8,}/iu,
    /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  ].some((pattern) => pattern.test(text));
}

function redactStructuredSecrets(text: string): { redacted: boolean; text: string } {
  let redacted = false;
  const keyPattern = String.raw`(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)`;
  const structuredKeyValue = new RegExp(
    String.raw`(["'])(${keyPattern})\1\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)`,
    'giu',
  );
  const redactedText = text.replace(structuredKeyValue, (_match, quote: string, key: string) => {
    redacted = true;
    return `${quote}${key}${quote}:"[REDACTED]"`;
  });
  return { redacted, text: redactedText };
}

function splitSearchText(text: string): Array<{
  charEnd: number;
  charStart: number;
  text: string;
  tokenEnd: number;
  tokenStart: number;
}> {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  if (tokens.length <= MAX_UNSPLIT_TOKENS) {
    return [
      {
        charEnd: text.length,
        charStart: 0,
        text,
        tokenEnd: tokens.length,
        tokenStart: 0,
      },
    ];
  }

  const chunkCount = Math.max(
    2,
    Math.ceil(
      (tokens.length - CHUNK_OVERLAP_TOKENS) / (TARGET_CHUNK_TOKENS - CHUNK_OVERLAP_TOKENS),
    ),
  );
  const chunkSize = Math.min(
    MAX_UNSPLIT_TOKENS,
    Math.max(
      MIN_CHUNK_TOKENS,
      Math.ceil((tokens.length + CHUNK_OVERLAP_TOKENS * (chunkCount - 1)) / chunkCount),
    ),
  );
  const stride = chunkSize - CHUNK_OVERLAP_TOKENS;
  const chunks: Array<{
    charEnd: number;
    charStart: number;
    text: string;
    tokenEnd: number;
    tokenStart: number;
  }> = [];

  for (let tokenStart = 0; tokenStart < tokens.length; tokenStart += stride) {
    const tokenEnd = Math.min(tokens.length, tokenStart + chunkSize);
    const charStart = tokens[tokenStart]?.start ?? 0;
    const charEnd = tokens[tokenEnd - 1]?.end ?? text.length;
    chunks.push({
      charEnd,
      charStart,
      text: text.slice(charStart, charEnd),
      tokenEnd,
      tokenStart,
    });
    if (tokenEnd === tokens.length) break;
  }

  return chunks;
}

function tokenize(text: string): Array<{ end: number; start: number }> {
  return Array.from(text.matchAll(/\S+/gu), (match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0,
  }));
}

function buildSegmentMetadata(
  turns: readonly SessionTurn[],
  segmentTurn: SessionTurn,
  extraction: TextExtraction,
  chunk: {
    charEnd: number;
    charStart: number;
    chunkCount: number;
    chunkIndex: number;
    searchTextLength: number;
    tokenEnd: number;
    tokenStart: number;
    toolGroup?: ToolGroupContext | undefined;
  },
): JsonRecord {
  const primaryTurn = segmentTurn;
  const metadata = compactRecord({
    actorKind: primaryTurn.actorKind,
    actorLabel: primaryTurn.actorLabel,
    chunkCount: chunk.chunkCount,
    chunkIndex: chunk.chunkIndex,
    contentPartTypes: extraction.contentPartTypes,
    filters: extraction.filters,
    groupedActorKinds: turns.map((turn) => turn.actorKind),
    groupedContentPartTypes: turns.map((turn) => contentPartTypes(turn)),
    groupedHarnessTurnIds: turns.map((turn) => turn.harnessTurnId).filter((id) => id !== null),
    groupedRoles: turns.map((turn) => turn.role),
    groupedTurnIds: turns.map((turn) => turn.id),
    groupedTurnOrdinals: turns.map((turn) => turn.ordinal),
    harnessTurnId: primaryTurn.harnessTurnId,
    normalizer: DERIVER,
    role: primaryTurn.role,
    searchTextSpan: {
      charEnd: chunk.charEnd,
      charStart: chunk.charStart,
      tokenEnd: chunk.tokenEnd,
      tokenStart: chunk.tokenStart,
    },
    segmentRawSpan: segmentRawSpan(primaryTurn.rawSpan, chunk),
    segmentSourceRawSpan: primaryTurn.rawSpan,
    segmentTurnId: primaryTurn.id,
    segmentTurnOrdinal: primaryTurn.ordinal,
    skippedPartCount: extraction.skippedPartCount,
    sourceRawSpans: turns.map((turn) => turn.rawSpan),
    sourceTurnSpans: turns.map((turn) => ({
      harnessTurnId: turn.harnessTurnId,
      rawSpan: turn.rawSpan,
      turnId: turn.id,
      turnOrdinal: turn.ordinal,
    })),
    turnOrdinal: primaryTurn.ordinal,
  });
  if (chunk.toolGroup === undefined) return metadata;

  return {
    ...metadata,
    toolGroup: compactRecord({
      callId: chunk.toolGroup.callId,
      contentPartTypes: chunk.toolGroup.contentPartTypes,
      filters: chunk.toolGroup.filters,
      memberCount: chunk.toolGroup.memberCount,
      memberIndex: chunk.toolGroup.memberIndex,
      skippedPartCount: chunk.toolGroup.skippedPartCount,
      turnIds: chunk.toolGroup.turns.map((turn) => turn.id),
      turnOrdinals: chunk.toolGroup.turns.map((turn) => turn.ordinal),
    }),
  };
}

function buildSkippedSegmentMetadata(
  turns: readonly SessionTurn[],
  segmentTurn: SessionTurn,
  extraction: TextExtraction,
  toolGroup?: ToolGroupContext,
): JsonRecord {
  const primaryTurn = segmentTurn;
  const metadata = compactRecord({
    actorKind: primaryTurn.actorKind,
    actorLabel: primaryTurn.actorLabel,
    contentPartTypes: extraction.contentPartTypes,
    filterReasons: uniqueFilterReasons(extraction.filters),
    filters: extraction.filters,
    groupedActorKinds: turns.map((turn) => turn.actorKind),
    groupedContentPartTypes: turns.map((turn) => contentPartTypes(turn)),
    groupedHarnessTurnIds: turns.map((turn) => turn.harnessTurnId).filter((id) => id !== null),
    groupedRoles: turns.map((turn) => turn.role),
    groupedTurnIds: turns.map((turn) => turn.id),
    groupedTurnOrdinals: turns.map((turn) => turn.ordinal),
    harnessTurnId: primaryTurn.harnessTurnId,
    normalizer: DERIVER,
    omittedSearchText: true,
    omissionReason: 'all_content_filtered_or_empty',
    role: primaryTurn.role,
    searchTextSpan: null,
    segmentRawSpan: null,
    segmentSourceRawSpan: primaryTurn.rawSpan,
    segmentStatus: 'skipped',
    segmentTurnId: primaryTurn.id,
    segmentTurnOrdinal: primaryTurn.ordinal,
    skippedPartCount: extraction.skippedPartCount,
    sourceRawSpans: turns.map((turn) => turn.rawSpan),
    sourceTurnSpans: turns.map((turn) => ({
      harnessTurnId: turn.harnessTurnId,
      rawSpan: turn.rawSpan,
      turnId: turn.id,
      turnOrdinal: turn.ordinal,
    })),
    turnOrdinal: primaryTurn.ordinal,
  });
  if (toolGroup === undefined) return metadata;

  return {
    ...metadata,
    toolGroup: compactRecord({
      callId: toolGroup.callId,
      contentPartTypes: toolGroup.contentPartTypes,
      filterReasons: uniqueFilterReasons(toolGroup.filters),
      filters: toolGroup.filters,
      memberCount: toolGroup.memberCount,
      memberIndex: toolGroup.memberIndex,
      skippedPartCount: toolGroup.skippedPartCount,
      turnIds: toolGroup.turns.map((turn) => turn.id),
      turnOrdinals: toolGroup.turns.map((turn) => turn.ordinal),
    }),
  };
}

function contentPartTypes(turn: SessionTurn): string[] {
  const parts = Array.isArray(turn.contentParts) ? turn.contentParts : [];
  return parts.map((part) => readString(asRecord(part).type) ?? 'unknown');
}

function uniqueFilterReasons(filters: readonly FilterReason[]): string[] {
  return Array.from(new Set(filters.map((filter) => filter.reason))).sort();
}

function segmentRawSpan(
  rawSpan: Record<string, unknown>,
  chunk: { charEnd: number; charStart: number; searchTextLength: number },
): JsonRecord | undefined {
  const rawCharStart = typeof rawSpan.charStart === 'number' ? rawSpan.charStart : undefined;
  const rawCharEnd = typeof rawSpan.charEnd === 'number' ? rawSpan.charEnd : undefined;
  if (rawCharStart === undefined || rawCharEnd === undefined || rawCharEnd < rawCharStart) {
    return undefined;
  }

  const isFullTurn = chunk.charStart === 0 && chunk.charEnd === chunk.searchTextLength;
  if (isFullTurn) return rawSpan;

  const estimatedStart = Math.min(rawCharStart + chunk.charStart, rawCharEnd);
  const estimatedEnd = Math.min(rawCharStart + chunk.charEnd, rawCharEnd);
  return {
    ...rawSpan,
    charEnd: Math.max(estimatedStart, estimatedEnd),
    charStart: estimatedStart,
    estimate: 'search_text_offset_within_turn_raw_span',
  };
}

function buildToolGroupContexts(turns: readonly SessionTurn[]): Map<string, ToolGroupContext> {
  const contexts = new Map<string, ToolGroupContext>();

  for (const toolStream of contiguousToolStreams(turns)) {
    const entriesByCallId = new Map<
      string,
      {
        calls: SessionTurn[];
        results: SessionTurn[];
      }
    >();

    for (const turn of toolStream) {
      const evidence = unambiguousToolEvidence(turn);
      if (evidence?.partType === 'tool_call') {
        const entries = entriesByCallId.get(evidence.callId) ?? { calls: [], results: [] };
        entries.calls.push(turn);
        entriesByCallId.set(evidence.callId, entries);
      }

      if (evidence?.partType === 'tool_result') {
        const entries = entriesByCallId.get(evidence.callId) ?? { calls: [], results: [] };
        entries.results.push(turn);
        entriesByCallId.set(evidence.callId, entries);
      }
    }

    for (const [callId, entries] of entriesByCallId) {
      if (entries.calls.length !== 1 || entries.results.length !== 1) continue;
      const callTurn = entries.calls[0];
      const resultTurn = entries.results[0];
      if (callTurn === undefined || resultTurn === undefined) continue;
      if (callTurn.ordinal >= resultTurn.ordinal) continue;

      const groupTurns = [callTurn, resultTurn] as const;
      const groupExtraction = extractGroupSearchText(groupTurns);
      const groupContext = {
        callId,
        contentPartTypes: groupExtraction.contentPartTypes,
        filters: groupExtraction.filters,
        memberCount: groupTurns.length,
        skippedPartCount: groupExtraction.skippedPartCount,
        turns: groupTurns,
      };

      groupTurns.forEach((turn, memberIndex) => {
        contexts.set(turn.id, {
          ...groupContext,
          memberIndex,
        });
      });
    }
  }

  return contexts;
}

function contiguousToolStreams(turns: readonly SessionTurn[]): SessionTurn[][] {
  const streams: SessionTurn[][] = [];
  let current: SessionTurn[] = [];

  for (const turn of turns) {
    if (isToolBearingTurn(turn)) {
      current.push(turn);
      continue;
    }

    if (current.length > 0) {
      streams.push(current);
      current = [];
    }
  }

  if (current.length > 0) streams.push(current);
  return streams;
}

function isToolBearingTurn(turn: SessionTurn): boolean {
  const parts = Array.isArray(turn.contentParts) ? turn.contentParts.map(asRecord) : [];
  return parts.some((part) => {
    const type = readString(part.type);
    return type === 'tool_call' || type === 'tool_result';
  });
}

function unambiguousToolEvidence(turn: SessionTurn): ToolEvidence | undefined {
  const parts = Array.isArray(turn.contentParts) ? turn.contentParts.map(asRecord) : [];
  const toolParts = parts.filter((entry) => {
    const type = readString(entry.type);
    return type === 'tool_call' || type === 'tool_result';
  });
  if (toolParts.length !== 1) return undefined;

  const [part] = toolParts;
  if (part === undefined) return undefined;
  const partType = readString(part.type);
  const callId = readString(part.callId);
  if ((partType !== 'tool_call' && partType !== 'tool_result') || callId === undefined) {
    return undefined;
  }
  return { callId, partType };
}

function segmentMatches(
  actual: SessionSegment | undefined,
  expected: NewSessionSegment,
  expectedOrdinal: number,
): boolean {
  if (actual === undefined) return false;
  return (
    actual.activityIntervalId === expected.activityIntervalId &&
    nullableEqual(actual.charEnd, expected.charEnd) &&
    nullableEqual(actual.charStart, expected.charStart) &&
    jsonEqual(actual.metadata, expected.metadata) &&
    actual.ordinal === expectedOrdinal &&
    actual.rawSessionRecordId === expected.rawSessionRecordId &&
    actual.searchText === expected.searchText &&
    actual.segmentKind === expected.segmentKind &&
    actual.sessionId === expected.sessionId &&
    nullableEqual(actual.snippet, expected.snippet) &&
    nullableEqual(actual.tokenEnd, expected.tokenEnd) &&
    nullableEqual(actual.tokenStart, expected.tokenStart) &&
    actual.turnId === expected.turnId &&
    actual.workspaceId === expected.workspaceId
  );
}

function nullableEqual(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function buildSnippet(text: string): string {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim();
  return normalized.length <= SNIPPET_CHARS
    ? normalized
    : `${normalized.slice(0, SNIPPET_CHARS - 1)}...`;
}

function normalizeSearchText(text: string): string {
  return text
    .replaceAll(/\r\n/gu, '\n')
    .replaceAll(/[ \t]+/gu, ' ')
    .replaceAll(/\n{3,}/gu, '\n\n')
    .trim();
}

function stringifyForSearch(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function compactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, canonicalJson(entryValue)]),
  );
}
