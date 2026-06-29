import type {
  NormalizedActorKind,
  NormalizedTranscriptTurn,
  NormalizedTurnRole,
  TranscriptImportHints,
  TranscriptNormalization,
} from './transcript-normalizer.js';

export type CodexTranscriptImportHints = TranscriptImportHints;
export type CodexTranscriptNormalization = TranscriptNormalization;

type ParsedJsonRecord = {
  byteEnd: number;
  byteStart: number;
  charEnd: number;
  charStart: number;
  index: number;
  lineNumber: number;
  rawLine: string;
  value: Record<string, unknown>;
};

type ParsedJsonRecords = {
  parseErrors: Record<string, unknown>[];
  records: ParsedJsonRecord[];
};

type RawSpan = {
  byteEnd: number;
  byteStart: number;
  charEnd: number;
  charStart: number;
  lineEnd: number;
  lineStart: number;
} & Record<string, unknown>;

type TranscriptState = {
  callIdToToolName: Map<string, string>;
  callIdToTurnId: Map<string, string>;
  currentTurnId: string | undefined;
  cwd: string | undefined;
  lifecycleEvents: Record<string, unknown>[];
  model: string | undefined;
  parseErrors: Record<string, unknown>[];
  responseMessageKeys: Set<string>;
  sessionMeta: Record<string, unknown> | undefined;
  turnContexts: Record<string, unknown>[];
};

export function extractCodexTranscriptImportHints(input: {
  contentType: 'json' | 'jsonl' | 'text';
  rawContent: string;
}): CodexTranscriptImportHints {
  const { records } = parseCodexJsonRecords(input);
  const sessionMeta = records.find((record) => record.value.type === 'session_meta')?.value;
  const sessionPayload = asRecord(sessionMeta?.payload);
  const turnContext = records.find((record) => record.value.type === 'turn_context')?.value;
  const turnPayload = asRecord(turnContext?.payload);

  return {
    cwd: readString(sessionPayload?.cwd) ?? readString(turnPayload?.cwd),
    harnessSessionId: readString(sessionPayload?.id),
    model: readString(turnPayload?.model) ?? readString(sessionPayload?.model),
  };
}

export function normalizeCodexTranscript(input: {
  contentType: 'json' | 'jsonl' | 'text';
  fallbackHarnessSessionId?: string | undefined;
  fallbackModel?: string | undefined;
  rawContent: string;
}): CodexTranscriptNormalization | undefined {
  const { parseErrors, records } = parseCodexJsonRecords(input);
  if (records.length === 0 && parseErrors.length === 0) {
    return undefined;
  }

  const state: TranscriptState = {
    callIdToToolName: new Map(),
    callIdToTurnId: new Map(),
    currentTurnId: undefined,
    cwd: undefined,
    lifecycleEvents: [],
    model: input.fallbackModel,
    parseErrors,
    responseMessageKeys: responseMessageKeys(records),
    sessionMeta: undefined,
    turnContexts: [],
  };

  const turns: NormalizedTranscriptTurn[] = [];
  for (const record of records) {
    const type = readString(record.value.type);
    const payload = asRecord(record.value.payload);
    const payloadType = readString(payload?.type);

    if (type === 'session_meta') {
      state.sessionMeta = payload;
      state.cwd = readString(payload?.cwd) ?? state.cwd;
      continue;
    }

    if (type === 'turn_context') {
      state.currentTurnId = readString(payload?.turn_id) ?? state.currentTurnId;
      state.cwd = readString(payload?.cwd) ?? state.cwd;
      state.model = readString(payload?.model) ?? state.model;
      state.turnContexts.push(compactRecord(payload ?? {}));
      continue;
    }

    if (type === 'event_msg') {
      handleEventMessage(record, payload, payloadType, state, turns);
      continue;
    }

    if (type === 'response_item' && payload !== undefined) {
      const turn = responseItemTurn(record, payload, state);
      if (turn !== undefined) {
        turns.push(turn);
      }
      continue;
    }

    if (type === 'compacted') {
      state.lifecycleEvents.push(topLevelLifecycleEvent(record));
      continue;
    }

    const legacyTurn = legacyTopLevelTurn(record, state);
    if (legacyTurn !== undefined) {
      turns.push(legacyTurn);
    }
  }

  for (const turn of turns) {
    turn.metadata = compactRecord({
      ...turn.metadata,
      codexTurnId: turn.codexTurnId,
      cwd: state.cwd,
      normalizer: 'codex-transcript-v1',
    });
  }
  const sortedTurns = turns;

  const timestamps = sortedTurns.flatMap((turn) => [turn.startedAt, turn.endedAt]).filter(isDate);
  const startedAt = earliest(timestamps);
  const lastActivityAt = latest(timestamps);
  const sessionId = readString(state.sessionMeta?.id) ?? input.fallbackHarnessSessionId;
  const subagentEvidence = collectSubagentEvidence(records);

  return {
    activityInterval: {
      metadata: compactRecord({
        cwd: state.cwd,
        lifecycleEvents: state.lifecycleEvents,
        normalizer: 'codex-transcript-v1',
        parseErrors: state.parseErrors,
        turnContexts: state.turnContexts,
      }),
      startedAt,
    },
    metadata: compactRecord({
      cwd: state.cwd,
      detectedHarnessSessionId: sessionId,
      lifecycleEvents: state.lifecycleEvents,
      normalizer: 'codex-transcript-v1',
      parseErrors: state.parseErrors,
      sessionMeta: state.sessionMeta,
      subagentEvidence,
      turnCount: sortedTurns.length,
    }),
    session: {
      lastActivityAt,
      metadata: compactRecord({
        cliVersion: readString(state.sessionMeta?.cli_version),
        cwd: state.cwd,
        detectedHarnessSessionId: sessionId,
        git: state.sessionMeta?.git,
        lifecycleEventCount: state.lifecycleEvents.length,
        modelProvider: readString(state.sessionMeta?.model_provider),
        normalizer: 'codex-transcript-v1',
        subagentEvidence,
        turnCount: sortedTurns.length,
      }),
      model: state.model,
      startedAt,
    },
    turns: sortedTurns,
  };
}

function handleEventMessage(
  record: ParsedJsonRecord,
  payload: Record<string, unknown> | undefined,
  payloadType: string | undefined,
  state: TranscriptState,
  turns: NormalizedTranscriptTurn[],
): void {
  if (payload === undefined) {
    return;
  }
  const turnId = readString(payload.turn_id);
  if (turnId !== undefined) {
    state.currentTurnId = turnId;
  }
  state.lifecycleEvents.push(
    compactRecord({
      payload: lifecyclePayload(payload),
      rawSpan: rawSpan(record),
      timestamp: readString(record.value.timestamp),
      type: payloadType,
    }),
  );

  if (payloadType !== 'agent_message' && payloadType !== 'user_message') {
    return;
  }
  const message = readString(payload.message);
  if (message === undefined) {
    return;
  }

  const role = payloadType === 'user_message' ? 'user' : 'assistant';
  if (
    state.responseMessageKeys.has(messageKey(role, message, readString(record.value.timestamp)))
  ) {
    return;
  }

  turns.push({
    actorKind: role === 'user' ? 'host_user' : 'agent',
    contentParts: [{ text: message, type: 'text' }],
    codexTurnId: state.currentTurnId,
    harnessTurnId: stableHarnessTurnId(record, role, state.currentTurnId),
    metadata: { sourceRecordType: 'event_msg', sourcePayloadType: payloadType },
    rawSpan: rawSpan(record),
    role,
    searchText: message,
    startedAt: parseOptionalDate(readString(record.value.timestamp)),
  });
}

function responseItemTurn(
  record: ParsedJsonRecord,
  payload: Record<string, unknown>,
  state: TranscriptState,
): NormalizedTranscriptTurn | undefined {
  const payloadType = readString(payload.type);
  const metadata = asRecord(payload.metadata);
  const codexTurnId = readString(metadata?.turn_id) ?? state.currentTurnId;
  const timestamp = parseOptionalDate(readString(record.value.timestamp));

  if (payloadType === 'message') {
    const role = normalizeRole(readString(payload.role));
    if (role === undefined) {
      return undefined;
    }
    const contentParts = normalizeContentParts(payload.content);
    const searchText = contentPartsToSearchText(contentParts);
    if (contentParts.length === 0 && searchText === '') {
      return undefined;
    }
    return {
      actorKind: actorKindForRole(role),
      actorLabel: actorLabelForRole(role, payload),
      codexTurnId,
      contentParts,
      harnessTurnId: readString(payload.id) ?? stableHarnessTurnId(record, role, codexTurnId),
      metadata: compactRecord({
        phase: readString(payload.phase),
        sourcePayloadType: payloadType,
        sourceRecordType: 'response_item',
      }),
      model: state.model,
      rawSpan: rawSpan(record),
      role,
      searchText,
      startedAt: timestamp,
    };
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const callId = readString(payload.call_id);
    const name = readString(payload.name) ?? 'tool';
    if (callId !== undefined) {
      state.callIdToToolName.set(callId, name);
      if (codexTurnId !== undefined) {
        state.callIdToTurnId.set(callId, codexTurnId);
      }
    }
    const argumentsText = readString(payload.arguments);
    const customInput = payloadType === 'custom_tool_call' ? payload.input : undefined;
    const contentParts = [
      compactRecord({
        arguments:
          payloadType === 'function_call'
            ? (parseJsonValue(argumentsText) ?? argumentsText)
            : undefined,
        callId,
        input: customInput,
        name,
        status: readString(payload.status),
        type: 'tool_call',
      }),
    ];
    return {
      actorKind: 'tool',
      actorLabel: name,
      codexTurnId,
      contentParts,
      harnessTurnId:
        readString(payload.id) ?? callId ?? stableHarnessTurnId(record, 'tool', codexTurnId),
      metadata: { sourcePayloadType: payloadType, sourceRecordType: 'response_item' },
      model: state.model,
      rawSpan: rawSpan(record),
      role: 'tool',
      searchText: contentPartsToSearchText(contentParts),
      startedAt: timestamp,
    };
  }

  if (payloadType === 'web_search_call') {
    const callId = readString(payload.call_id) ?? readString(payload.id);
    const name = 'web_search';
    if (callId !== undefined) {
      state.callIdToToolName.set(callId, name);
      if (codexTurnId !== undefined) {
        state.callIdToTurnId.set(callId, codexTurnId);
      }
    }
    const action = asRecord(payload.action) ?? payload.action;
    const contentParts = [
      compactRecord({
        action,
        callId,
        name,
        status: readString(payload.status),
        type: 'tool_call',
      }),
    ];
    return {
      actorKind: 'tool',
      actorLabel: name,
      codexTurnId,
      contentParts,
      harnessTurnId:
        readString(payload.id) ?? callId ?? stableHarnessTurnId(record, 'tool', codexTurnId),
      metadata: { sourcePayloadType: payloadType, sourceRecordType: 'response_item' },
      model: state.model,
      rawSpan: rawSpan(record),
      role: 'tool',
      searchText: contentPartsToSearchText(contentParts),
      startedAt: timestamp,
    };
  }

  if (payloadType === 'tool_search_call') {
    const callId = readString(payload.call_id) ?? readString(payload.id);
    const name = 'tool_search';
    if (callId !== undefined) {
      state.callIdToToolName.set(callId, name);
      if (codexTurnId !== undefined) {
        state.callIdToTurnId.set(callId, codexTurnId);
      }
    }
    const contentParts = [
      compactRecord({
        arguments: normalizeToolArguments(payload.arguments),
        callId,
        execution: payload.execution,
        name,
        status: readString(payload.status),
        tools: payload.tools,
        type: 'tool_call',
      }),
    ];
    return {
      actorKind: 'tool',
      actorLabel: name,
      codexTurnId,
      contentParts,
      harnessTurnId:
        readString(payload.id) ?? callId ?? stableHarnessTurnId(record, 'tool', codexTurnId),
      metadata: { sourcePayloadType: payloadType, sourceRecordType: 'response_item' },
      model: state.model,
      rawSpan: rawSpan(record),
      role: 'tool',
      searchText: contentPartsToSearchText(contentParts),
      startedAt: timestamp,
    };
  }

  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    const callId = readString(payload.call_id);
    const name = callId === undefined ? undefined : state.callIdToToolName.get(callId);
    const turnId =
      callId === undefined ? codexTurnId : (state.callIdToTurnId.get(callId) ?? codexTurnId);
    const contentParts = [
      compactRecord({
        callId,
        name,
        output: normalizeToolOutput(payload.output),
        type: 'tool_result',
      }),
    ];
    return {
      actorKind: 'tool',
      actorLabel: name,
      codexTurnId: turnId,
      contentParts,
      harnessTurnId: stableHarnessTurnId(record, 'tool', callId ?? turnId),
      metadata: { sourcePayloadType: payloadType, sourceRecordType: 'response_item' },
      rawSpan: rawSpan(record),
      role: 'tool',
      searchText: contentPartsToSearchText(contentParts),
      startedAt: timestamp,
    };
  }

  if (payloadType === 'tool_search_output') {
    const callId = readString(payload.call_id) ?? readString(payload.id);
    const name =
      callId === undefined ? 'tool_search' : (state.callIdToToolName.get(callId) ?? 'tool_search');
    const turnId =
      callId === undefined ? codexTurnId : (state.callIdToTurnId.get(callId) ?? codexTurnId);
    const contentParts = [
      compactRecord({
        callId,
        execution: payload.execution,
        name,
        output: normalizeToolOutput(payload.output),
        status: readString(payload.status),
        tools: payload.tools,
        type: 'tool_result',
      }),
    ];
    return {
      actorKind: 'tool',
      actorLabel: name,
      codexTurnId: turnId,
      contentParts,
      harnessTurnId: stableHarnessTurnId(record, 'tool', callId ?? turnId),
      metadata: { sourcePayloadType: payloadType, sourceRecordType: 'response_item' },
      rawSpan: rawSpan(record),
      role: 'tool',
      searchText: contentPartsToSearchText(contentParts),
      startedAt: timestamp,
    };
  }

  if (payloadType === 'reasoning') {
    const contentParts = normalizeReasoningParts(payload.summary);
    const searchText = contentPartsToSearchText(contentParts);
    if (contentParts.length === 0 || searchText === '') {
      return undefined;
    }
    return {
      actorKind: 'agent',
      codexTurnId,
      contentParts,
      harnessTurnId:
        readString(payload.id) ?? stableHarnessTurnId(record, 'assistant', codexTurnId),
      metadata: { sourcePayloadType: payloadType, sourceRecordType: 'response_item' },
      model: state.model,
      rawSpan: rawSpan(record),
      role: 'assistant',
      searchText,
      startedAt: timestamp,
    };
  }

  return undefined;
}

function topLevelLifecycleEvent(record: ParsedJsonRecord): Record<string, unknown> {
  const payload = asRecord(record.value.payload);
  return compactRecord({
    payload: lifecyclePayload(payload ?? record.value),
    rawSpan: rawSpan(record),
    timestamp: readString(record.value.timestamp),
    type: readString(record.value.type),
  });
}

function legacyTopLevelTurn(
  record: ParsedJsonRecord,
  state: TranscriptState,
): NormalizedTranscriptTurn | undefined {
  const role = normalizeRole(readString(record.value.type));
  if (role === undefined) {
    return undefined;
  }
  const text = readString(record.value.text) ?? readString(record.value.content);
  if (text === undefined) {
    return undefined;
  }
  return {
    actorKind: actorKindForRole(role),
    contentParts: [{ text, type: 'text' }],
    harnessTurnId: stableHarnessTurnId(record, role, state.currentTurnId),
    metadata: { sourceRecordType: 'legacy-jsonl' },
    rawSpan: rawSpan(record),
    role,
    searchText: text,
    startedAt: parseOptionalDate(readString(record.value.timestamp)),
  };
}

function parseCodexJsonRecords(input: {
  contentType: 'json' | 'jsonl' | 'text';
  rawContent: string;
}): ParsedJsonRecords {
  if (input.contentType === 'json') {
    const parsed = tryParseJson(input.rawContent);
    if (!parsed.ok) {
      return {
        parseErrors: [
          compactRecord({
            byteEnd: Buffer.byteLength(input.rawContent, 'utf8'),
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
      records: values.flatMap((value, index) =>
        asRecord(value) === undefined
          ? []
          : [
              {
                byteEnd: Buffer.byteLength(input.rawContent, 'utf8'),
                byteStart: 0,
                charEnd: input.rawContent.length,
                charStart: 0,
                index,
                lineNumber: index,
                rawLine: input.rawContent,
                value: asRecord(value) ?? {},
              },
            ],
      ),
    };
  }

  if (input.contentType !== 'jsonl') {
    return { parseErrors: [], records: [] };
  }

  const records: ParsedJsonRecord[] = [];
  const parseErrors: Record<string, unknown>[] = [];
  let byteOffset = 0;
  let charOffset = 0;
  let lineNumber = 0;
  while (charOffset < input.rawContent.length) {
    const newlineIndex = input.rawContent.indexOf('\n', charOffset);
    const lineEndWithNewline = newlineIndex === -1 ? input.rawContent.length : newlineIndex + 1;
    const rawLineWithNewline = input.rawContent.slice(charOffset, lineEndWithNewline);
    const rawLine = rawLineWithNewline.replace(/\r?\n$/u, '');
    const trimmed = rawLine.trim();
    if (trimmed !== '') {
      const byteLength = Buffer.byteLength(rawLine, 'utf8');
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
    byteOffset += Buffer.byteLength(rawLineWithNewline, 'utf8');
    charOffset = lineEndWithNewline;
    lineNumber += 1;
  }

  return { parseErrors, records };
}

function responseMessageKeys(records: readonly ParsedJsonRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    if (record.value.type !== 'response_item') {
      continue;
    }
    const payload = asRecord(record.value.payload);
    if (payload?.type !== 'message') {
      continue;
    }
    const role = normalizeRole(readString(payload.role));
    if (role !== 'assistant' && role !== 'user') {
      continue;
    }
    const text = contentPartsToSearchText(normalizeContentParts(payload.content));
    if (text !== '') {
      keys.add(messageKey(role, text, readString(record.value.timestamp)));
    }
  }
  return keys;
}

function messageKey(role: string, text: string, timestamp: string | undefined): string {
  return `${role}\0${timestamp ?? ''}\0${text}`;
}

function normalizeContentParts(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') {
    return [{ text: value, type: 'text' }];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [{ text: entry, type: 'text' }];
    }
    const record = asRecord(entry);
    if (record === undefined) {
      return [];
    }
    const type = readString(record.type);
    const text = readString(record.text);
    if (text !== undefined) {
      return [
        compactRecord({
          text,
          type:
            type === 'input_text' || type === 'output_text' || type === undefined ? 'text' : type,
        }),
      ];
    }
    return [compactRecord({ ...record, type: type ?? 'unknown' })];
  });
}

function normalizeReasoningParts(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [{ text: entry, type: 'summary' }];
    }
    const record = asRecord(entry);
    const text = readString(record?.text);
    return text === undefined ? [] : [{ text, type: 'summary' }];
  });
}

function contentPartsToSearchText(parts: readonly Record<string, unknown>[]): string {
  return parts
    .map((part) => {
      const type = readString(part.type);
      if (type === 'tool_call') {
        return [
          readString(part.name),
          stringifyForSearch(part.arguments ?? part.input ?? part.action),
          stringifyForSearch(part.execution),
          stringifyForSearch(part.status),
          stringifyForSearch(part.tools),
        ]
          .filter(Boolean)
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
          .filter(Boolean)
          .join(' ');
      }
      if (typeof part.text === 'string') {
        return part.text;
      }
      if (typeof part.output === 'string') {
        return part.output;
      }
      if (typeof part.arguments === 'string') {
        return part.arguments;
      }
      return stringifyForSearch(part);
    })
    .filter((part) => part.trim() !== '')
    .join('\n')
    .trim();
}

function lifecyclePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return compactRecord({
    messageLength: typeof payload.message === 'string' ? payload.message.length : undefined,
    source: readString(payload.source),
    type: readString(payload.type),
    turnId: readString(payload.turn_id),
  });
}

function collectSubagentEvidence(records: readonly ParsedJsonRecord[]): Record<string, unknown>[] {
  return records.flatMap((record) => {
    const value = JSON.stringify(record.value);
    if (!/(subagent|child)/iu.test(value)) {
      return [];
    }
    const payload = asRecord(record.value.payload);
    const source = asRecord(payload?.source) ?? asRecord(record.value.source);
    const sourceSubagent = asRecord(source?.subagent);
    return [
      compactRecord({
        agent_role: readString(payload?.agent_role) ?? readString(record.value.agent_role),
        parent_thread_id:
          readString(payload?.parent_thread_id) ?? readString(record.value.parent_thread_id),
        rawSpan: rawSpan(record),
        source_subagent_thread_spawn: sourceSubagent?.thread_spawn,
        sourcePayloadType: readString(asRecord(record.value.payload)?.type),
        sourceRecordType: readString(record.value.type),
        thread_source: readString(payload?.thread_source) ?? readString(record.value.thread_source),
      }),
    ];
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

function stableHarnessTurnId(
  record: ParsedJsonRecord,
  role: string,
  codexTurnId: string | undefined,
): string {
  return [codexTurnId ?? 'record', role, record.lineNumber.toString()].join(':');
}

function normalizeRole(value: string | undefined): NormalizedTurnRole | undefined {
  if (value === 'assistant' || value === 'tool' || value === 'user') {
    return value;
  }
  if (value === 'developer' || value === 'system') {
    return 'system';
  }
  if (value === 'subagent') {
    return 'subagent';
  }
  return undefined;
}

function actorKindForRole(role: NormalizedTurnRole): NormalizedActorKind {
  if (role === 'assistant') {
    return 'agent';
  }
  if (role === 'subagent') {
    return 'subagent';
  }
  if (role === 'tool') {
    return 'tool';
  }
  if (role === 'user') {
    return 'host_user';
  }
  return 'harness';
}

function actorLabelForRole(
  role: NormalizedTurnRole,
  payload: Record<string, unknown>,
): string | undefined {
  if (role === 'system') {
    return readString(payload.role) ?? 'codex';
  }
  if (role === 'assistant') {
    return 'codex';
  }
  return undefined;
}

function parseOptionalDate(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function earliest(values: readonly Date[]): Date | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return new Date(Math.min(...values.map((value) => value.getTime())));
}

function latest(values: readonly Date[]): Date | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function isDate(value: Date | undefined): value is Date {
  return value instanceof Date;
}

function stringifyForSearch(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function normalizeToolOutput(value: unknown): unknown {
  if (typeof value === 'string') {
    return parseJsonValue(value) ?? value;
  }
  if (value === undefined) {
    return undefined;
  }
  return value;
}

function normalizeToolArguments(value: unknown): unknown {
  if (typeof value === 'string') {
    return parseJsonValue(value) ?? value;
  }
  if (value === undefined) {
    return undefined;
  }
  return value;
}

function parseJsonValue(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
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
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
