import type {
  NormalizedActorKind,
  NormalizedTranscriptTurn,
  NormalizedTurnRole,
  TranscriptImportHints,
  TranscriptNormalization,
} from "./transcript-normalizer.js";

interface ParsedJsonRecord {
  byteEnd: number;
  byteStart: number;
  charEnd: number;
  charStart: number;
  index: number;
  lineNumber: number;
  rawLine: string;
  value: Record<string, unknown>;
}

interface ParsedJsonRecords {
  parseErrors: Record<string, unknown>[];
  records: ParsedJsonRecord[];
}

interface RawSpan extends Record<string, unknown> {
  byteEnd: number;
  byteStart: number;
  charEnd: number;
  charStart: number;
  lineEnd: number;
  lineStart: number;
}

interface ClaudeTranscriptState {
  cwd: string | undefined;
  lifecycleEvents: Record<string, unknown>[];
  model: string | undefined;
  parseErrors: Record<string, unknown>[];
  sessionId: string | undefined;
  title: string | undefined;
  toolUseIdToName: Map<string, string>;
}

export type ClaudeTranscriptImportHints = TranscriptImportHints;
export type ClaudeTranscriptNormalization = TranscriptNormalization;

export function extractClaudeTranscriptImportHints(input: {
  contentType: "json" | "jsonl" | "text";
  rawContent: string;
}): ClaudeTranscriptImportHints {
  const { records } = parseClaudeJsonRecords(input);
  const sessionRecord = records.find((record) => readSessionId(record.value) !== undefined)?.value;
  const assistantRecord = records.find(
    (record) => asRecord(record.value.message) !== undefined,
  )?.value;
  const message = asRecord(assistantRecord?.message);

  return {
    cwd: readString(sessionRecord?.cwd),
    harnessSessionId: readSessionId(sessionRecord),
    model: readString(message?.model),
  };
}

export function normalizeClaudeTranscript(input: {
  contentType: "json" | "jsonl" | "text";
  fallbackHarnessSessionId?: string | undefined;
  fallbackModel?: string | undefined;
  rawContent: string;
  sourceLocator?: string | undefined;
}): ClaudeTranscriptNormalization | undefined {
  const { parseErrors, records } = parseClaudeJsonRecords(input);
  if (records.length === 0 && parseErrors.length === 0) return undefined;

  const state: ClaudeTranscriptState = {
    cwd: undefined,
    lifecycleEvents: [],
    model: input.fallbackModel,
    parseErrors,
    sessionId: input.fallbackHarnessSessionId,
    title: undefined,
    toolUseIdToName: new Map(),
  };

  const turns: NormalizedTranscriptTurn[] = [];
  for (const record of records) {
    const recordTurns = recordToTurns(record, state);
    turns.push(...recordTurns);
  }

  const sortedTurns = turns.map((turn) => ({
    ...turn,
    metadata: compactRecord({
      ...turn.metadata,
      cwd: state.cwd,
      normalizer: "claude-transcript-v1",
    }),
  }));

  const timestamps = sortedTurns.flatMap((turn) => [turn.startedAt, turn.endedAt]).filter(isDate);
  const startedAt = earliest(timestamps);
  const lastActivityAt = latest(timestamps);
  const subagentEvidence = collectSubagentEvidence(records, input.sourceLocator);

  return {
    activityInterval: {
      metadata: compactRecord({
        cwd: state.cwd,
        lifecycleEvents: state.lifecycleEvents,
        normalizer: "claude-transcript-v1",
        parseErrors: state.parseErrors,
      }),
      startedAt,
    },
    metadata: compactRecord({
      cwd: state.cwd,
      detectedHarnessSessionId: state.sessionId,
      lifecycleEvents: state.lifecycleEvents,
      normalizer: "claude-transcript-v1",
      parseErrors: state.parseErrors,
      sourceLocator: input.sourceLocator,
      subagentEvidence,
      title: state.title,
      turnCount: sortedTurns.length,
    }),
    session: {
      lastActivityAt,
      metadata: compactRecord({
        cwd: state.cwd,
        detectedHarnessSessionId: state.sessionId,
        normalizer: "claude-transcript-v1",
        subagentEvidence,
        turnCount: sortedTurns.length,
        version: firstString(records, "version"),
      }),
      model: state.model,
      startedAt,
      title: state.title,
    },
    turns: sortedTurns,
  };
}

function recordToTurns(
  record: ParsedJsonRecord,
  state: ClaudeTranscriptState,
): NormalizedTranscriptTurn[] {
  const value = record.value;
  const type = readString(value.type);
  state.sessionId = readSessionId(value) ?? state.sessionId;
  state.cwd = readString(value.cwd) ?? state.cwd;

  if (type === "ai-title") {
    state.title = readString(value.aiTitle) ?? state.title;
    state.lifecycleEvents.push(lifecycleEvent(record));
    return [];
  }

  if (isLifecycleRecord(value)) {
    state.lifecycleEvents.push(lifecycleEvent(record));
    return [];
  }

  if (type === "system") {
    const text = readString(value.content);
    if (text === undefined) return [];
    return [
      {
        actorKind: "harness",
        actorLabel: readString(value.subtype) ?? "claude",
        contentParts: [{ text, type: "text" }],
        harnessTurnId: stableHarnessTurnId(record, "system"),
        metadata: baseTurnMetadata(record),
        rawSpan: rawSpan(record),
        role: "system",
        searchText: text,
        startedAt: parseOptionalDate(readString(value.timestamp)),
      },
    ];
  }

  const message = asRecord(value.message);
  if (message === undefined) return legacyTopLevelTurn(record, state);

  const messageModel = readString(message.model);
  state.model = messageModel ?? state.model;
  const contentParts = normalizeMessageContent(message.content);
  if (contentParts.length === 0) return [];

  const role = normalizeRole(readString(message.role) ?? type);
  if (role === undefined) return [];

  const timestamp = parseOptionalDate(readString(value.timestamp));
  const metadata = baseTurnMetadata(record);
  if (role === "user" && contentParts.some((part) => part.type === "tool_result")) {
    return contentParts.map((part, index) => {
      const callId = readString(part.callId);
      const name = callId === undefined ? undefined : state.toolUseIdToName.get(callId);
      return {
        actorKind: "tool",
        actorLabel: name,
        contentParts: [compactRecord({ ...part, name })],
        harnessTurnId:
          callId === undefined ? stableHarnessTurnId(record, "tool", index) : `${callId}:result`,
        metadata,
        rawSpan: rawSpan(record),
        role: "tool",
        searchText: contentPartsToSearchText([compactRecord({ ...part, name })]),
        startedAt: timestamp,
      };
    });
  }

  if (role === "assistant") {
    const assistantTurns: NormalizedTranscriptTurn[] = [];
    const nonToolParts = contentParts.filter((part) => part.type !== "tool_call");
    if (nonToolParts.length > 0) {
      assistantTurns.push({
        actorKind: "agent",
        actorLabel: "claude",
        contentParts: nonToolParts,
        harnessTurnId: stableHarnessTurnId(record, "assistant"),
        metadata,
        model: messageModel ?? state.model,
        rawSpan: rawSpan(record),
        role: "assistant",
        searchText: contentPartsToSearchText(nonToolParts),
        startedAt: timestamp,
      });
    }

    for (const [partIndex, part] of contentParts.entries()) {
      if (part.type !== "tool_call") continue;
      const callId = readString(part.callId);
      const name = readString(part.name) ?? "tool";
      if (callId !== undefined) state.toolUseIdToName.set(callId, name);
      assistantTurns.push({
        actorKind: actorKindForToolCall(name),
        actorLabel: name,
        contentParts: [part],
        harnessTurnId: callId ?? stableHarnessTurnId(record, "tool", partIndex),
        metadata,
        model: messageModel ?? state.model,
        rawSpan: rawSpan(record),
        role: actorKindForToolCall(name) === "subagent" ? "subagent" : "tool",
        searchText: contentPartsToSearchText([part]),
        startedAt: timestamp,
      });
    }
    return assistantTurns;
  }

  const searchText = contentPartsToSearchText(contentParts);
  if (searchText === "") return [];
  return [
    {
      actorKind: actorKindForRole(role),
      contentParts,
      harnessTurnId: stableHarnessTurnId(record, role),
      metadata,
      rawSpan: rawSpan(record),
      role,
      searchText,
      startedAt: timestamp,
    },
  ];
}

function legacyTopLevelTurn(
  record: ParsedJsonRecord,
  state: ClaudeTranscriptState,
): NormalizedTranscriptTurn[] {
  const role = normalizeRole(readString(record.value.role) ?? readString(record.value.type));
  if (role === undefined) return [];
  const text = readString(record.value.text) ?? readString(record.value.content);
  if (text === undefined) return [];
  state.cwd = readString(record.value.cwd) ?? state.cwd;
  state.sessionId = readSessionId(record.value) ?? state.sessionId;
  return [
    {
      actorKind: actorKindForRole(role),
      contentParts: [{ text, type: "text" }],
      harnessTurnId: stableHarnessTurnId(record, role),
      metadata: baseTurnMetadata(record),
      rawSpan: rawSpan(record),
      role,
      searchText: text,
      startedAt: parseOptionalDate(readString(record.value.timestamp)),
    },
  ];
}

function parseClaudeJsonRecords(input: {
  contentType: "json" | "jsonl" | "text";
  rawContent: string;
}): ParsedJsonRecords {
  if (input.contentType === "json") {
    const parsed = tryParseJson(input.rawContent);
    if (!parsed.ok) {
      return {
        parseErrors: [
          compactRecord({
            byteEnd: Buffer.byteLength(input.rawContent, "utf8"),
            byteStart: 0,
            charEnd: input.rawContent.length,
            charStart: 0,
            lineNumber: 0,
            message: parsed.message,
          }),
        ],
        records: [],
      };
    }
    const values = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    return {
      parseErrors: [],
      records: values.flatMap((value, index) => {
        const record = asRecord(value);
        return record === undefined
          ? []
          : [
              {
                byteEnd: Buffer.byteLength(input.rawContent, "utf8"),
                byteStart: 0,
                charEnd: input.rawContent.length,
                charStart: 0,
                index,
                lineNumber: index,
                rawLine: input.rawContent,
                value: record,
              },
            ];
      }),
    };
  }

  if (input.contentType !== "jsonl") return { parseErrors: [], records: [] };

  const records: ParsedJsonRecord[] = [];
  const parseErrors: Record<string, unknown>[] = [];
  let byteOffset = 0;
  let charOffset = 0;
  let lineNumber = 0;
  while (charOffset < input.rawContent.length) {
    const newlineIndex = input.rawContent.indexOf("\n", charOffset);
    const lineEndWithNewline = newlineIndex === -1 ? input.rawContent.length : newlineIndex + 1;
    const rawLineWithNewline = input.rawContent.slice(charOffset, lineEndWithNewline);
    const rawLine = rawLineWithNewline.replace(/\r?\n$/u, "");
    const trimmed = rawLine.trim();
    if (trimmed !== "") {
      const byteLength = Buffer.byteLength(rawLine, "utf8");
      const parsed = tryParseJson(trimmed);
      if (!parsed.ok) {
        parseErrors.push(
          compactRecord({
            byteEnd: byteOffset + byteLength,
            byteStart: byteOffset,
            charEnd: charOffset + rawLine.length,
            charStart: charOffset,
            lineNumber,
            message: parsed.message,
            rawLine,
          }),
        );
      } else {
        const value = asRecord(parsed.value);
        if (value !== undefined) {
          records.push({
            byteEnd: byteOffset + byteLength,
            byteStart: byteOffset,
            charEnd: charOffset + rawLine.length,
            charStart: charOffset,
            index: records.length,
            lineNumber,
            rawLine,
            value,
          });
        }
      }
    }
    byteOffset += Buffer.byteLength(rawLineWithNewline, "utf8");
    charOffset = lineEndWithNewline;
    lineNumber += 1;
  }

  return { parseErrors, records };
}

function normalizeMessageContent(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ text: value, type: "text" }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => normalizeContentPart(entry));
}

function normalizeContentPart(entry: unknown): Record<string, unknown>[] {
  if (typeof entry === "string") return [{ text: entry, type: "text" }];
  const record = asRecord(entry);
  if (record === undefined) return [];
  const type = readString(record.type);
  if (type === "text") {
    const text = readString(record.text);
    return text === undefined ? [] : [{ text, type: "text" }];
  }
  if (type === "thinking") {
    const text = readString(record.thinking);
    return text === undefined ? [] : [{ text, type: "thinking" }];
  }
  if (type === "tool_use") {
    return [
      compactRecord({
        callId: readString(record.id),
        input: record.input,
        name: readString(record.name),
        type: "tool_call",
      }),
    ];
  }
  if (type === "tool_result") {
    return [
      compactRecord({
        callId: readString(record.tool_use_id),
        output: normalizeToolResultContent(record.content),
        type: "tool_result",
      }),
    ];
  }
  return [compactRecord({ ...record, type: type ?? "unknown" })];
}

function normalizeToolResultContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    const record = asRecord(entry);
    if (record === undefined) return entry;
    const type = readString(record.type);
    const text = readString(record.text);
    return text === undefined ? compactRecord({ ...record, type }) : compactRecord({ text, type });
  });
}

function contentPartsToSearchText(parts: readonly Record<string, unknown>[]): string {
  return parts
    .map((part) => {
      const type = readString(part.type);
      if (type === "tool_call") {
        return [readString(part.name), stringifyForSearch(part.input)].filter(Boolean).join(" ");
      }
      if (type === "tool_result") {
        return [readString(part.name), stringifyForSearch(part.output)].filter(Boolean).join(" ");
      }
      if (typeof part.text === "string") return part.text;
      if (typeof part.output === "string") return part.output;
      return stringifyForSearch(part);
    })
    .filter((part) => part.trim() !== "")
    .join("\n")
    .trim();
}

function isLifecycleRecord(value: Record<string, unknown>): boolean {
  const type = readString(value.type);
  return (
    type === "ai-title" ||
    type === "attachment" ||
    type === "bridge-session" ||
    type === "file-history-snapshot" ||
    type === "last-prompt" ||
    type === "mode" ||
    type === "permission-mode" ||
    type === "queue-operation"
  );
}

function lifecycleEvent(record: ParsedJsonRecord): Record<string, unknown> {
  const value = record.value;
  return compactRecord({
    aiTitle: readString(value.aiTitle),
    bridgeSessionId: readString(value.bridgeSessionId),
    leafUuid: readString(value.leafUuid),
    mode: readString(value.mode),
    operation: readString(value.operation),
    permissionMode: readString(value.permissionMode),
    rawSpan: rawSpan(record),
    sessionId: readSessionId(value),
    subtype: readString(value.subtype),
    timestamp: readString(value.timestamp),
    type: readString(value.type),
    uuid: readString(value.uuid),
  });
}

function collectSubagentEvidence(
  records: readonly ParsedJsonRecord[],
  sourceLocator: string | undefined,
): Record<string, unknown>[] {
  const evidence: Record<string, unknown>[] = [];
  if (sourceLocator?.includes("/subagents/") === true) {
    evidence.push({ sourceLocatorKind: "claude-subagent-transcript", sourceLocator });
  }

  for (const record of records) {
    const value = record.value;
    const message = asRecord(value.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const agentTool = content.find((part) => {
      const partRecord = asRecord(part);
      return partRecord?.type === "tool_use" && partRecord.name === "Agent";
    });
    const hasEvidence =
      value.isSidechain === true ||
      readString(value.agentId) !== undefined ||
      asRecord(value.attributionAgent) !== undefined ||
      asRecord(agentTool) !== undefined;

    if (!hasEvidence) continue;
    const agentToolRecord = asRecord(agentTool);
    evidence.push(
      compactRecord({
        agentId: readString(value.agentId),
        attributionAgent: value.attributionAgent,
        isSidechain: value.isSidechain === true ? true : undefined,
        parentUuid: readString(value.parentUuid),
        rawSpan: rawSpan(record),
        sourceRecordType: readString(value.type),
        sourceToolAssistantUUID: readString(value.sourceToolAssistantUUID),
        sourceToolUseID: readString(value.sourceToolUseID),
        toolInput: agentToolRecord?.input,
        toolUseId: readString(agentToolRecord?.id),
      }),
    );
  }

  return evidence;
}

function baseTurnMetadata(record: ParsedJsonRecord): Record<string, unknown> {
  return compactRecord({
    agentId: readString(record.value.agentId),
    attributionAgent: record.value.attributionAgent,
    attributionPlugin: record.value.attributionPlugin,
    attributionSkill: record.value.attributionSkill,
    gitBranch: readString(record.value.gitBranch),
    isMeta: record.value.isMeta,
    isSidechain: record.value.isSidechain,
    messageId: readString(asRecord(record.value.message)?.id),
    parentUuid: readString(record.value.parentUuid),
    promptId: readString(record.value.promptId),
    requestId: readString(record.value.requestId),
    sessionId: readSessionId(record.value),
    sourceRecordType: readString(record.value.type),
    sourceToolAssistantUUID: readString(record.value.sourceToolAssistantUUID),
    sourceToolUseID: readString(record.value.sourceToolUseID),
    subtype: readString(record.value.subtype),
    userType: readString(record.value.userType),
    uuid: readString(record.value.uuid),
    version: readString(record.value.version),
  });
}

function rawSpan(record: ParsedJsonRecord): RawSpan {
  return {
    byteEnd: record.byteEnd,
    byteStart: record.byteStart,
    charEnd: record.charEnd,
    charStart: record.charStart,
    lineEnd: record.lineNumber,
    lineStart: record.lineNumber,
  };
}

function stableHarnessTurnId(record: ParsedJsonRecord, role: string, partIndex?: number): string {
  const stableId =
    readString(record.value.uuid) ??
    readString(asRecord(record.value.message)?.id) ??
    readString(record.value.promptId) ??
    `record:${record.lineNumber.toString()}`;
  return [stableId, role, partIndex?.toString()].filter(Boolean).join(":");
}

function readSessionId(value: Record<string, unknown> | undefined): string | undefined {
  return readString(value?.sessionId) ?? readString(value?.session_id);
}

function firstString(records: readonly ParsedJsonRecord[], field: string): string | undefined {
  for (const record of records) {
    const value = readString(record.value[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeRole(value: string | undefined): NormalizedTurnRole | undefined {
  if (value === "assistant" || value === "tool" || value === "user") return value;
  if (value === "developer" || value === "system") return "system";
  if (value === "subagent") return "subagent";
  return undefined;
}

function actorKindForRole(role: NormalizedTurnRole): NormalizedActorKind {
  if (role === "assistant") return "agent";
  if (role === "subagent") return "subagent";
  if (role === "tool") return "tool";
  if (role === "user") return "host_user";
  return "harness";
}

function actorKindForToolCall(name: string): "subagent" | "tool" {
  return name === "Agent" ? "subagent" : "tool";
}

function parseOptionalDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function earliest(values: readonly Date[]): Date | undefined {
  if (values.length === 0) return undefined;
  return new Date(Math.min(...values.map((value) => value.getTime())));
}

function latest(values: readonly Date[]): Date | undefined {
  if (values.length === 0) return undefined;
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function isDate(value: Date | undefined): value is Date {
  return value instanceof Date;
}

function stringifyForSearch(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function tryParseJson(
  value: string,
): { ok: true; value: unknown } | { message: string; ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (cause) {
    return { message: errorMessage(cause), ok: false };
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
