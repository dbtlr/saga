import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { RawEventEnvelope } from '@saga/contracts';

export const packageName = '@saga/collectors';

export type HarnessSource = 'claude' | 'codex';

export interface HarnessHookInput {
  cwd?: string | undefined;
  hook_event_name?: string | undefined;
  model?: string | undefined;
  permission_mode?: string | undefined;
  session_id?: string | undefined;
  transcript_path?: string | null | undefined;
  turn_id?: string | undefined;
  [key: string]: unknown;
}

export type CodexHookInput = HarnessHookInput;
export type ClaudeHookInput = HarnessHookInput;

export interface HarnessWorkspaceBinding {
  sourceBinding: {
    id: string;
  };
  workspace: {
    id: string;
  };
}

export function rawEventFromCodexHook(
  input: CodexHookInput,
  binding: {
    codexSourceBinding: {
      id: string;
    };
    workspace: {
      id: string;
    };
  },
  now = new Date(),
): RawEventEnvelope {
  return rawEventFromHarnessHook(
    input,
    {
      sourceBinding: binding.codexSourceBinding,
      workspace: binding.workspace,
    },
    'codex',
    now,
  );
}

export function rawEventFromClaudeHook(
  input: ClaudeHookInput,
  binding: HarnessWorkspaceBinding,
  now = new Date(),
): RawEventEnvelope {
  return rawEventFromHarnessHook(input, binding, 'claude', now);
}

export function rawEventFromHarnessHook(
  input: HarnessHookInput,
  binding: HarnessWorkspaceBinding,
  source: HarnessSource,
  now = new Date(),
): RawEventEnvelope {
  const hookEventName = normalizeHookEventName(input.hook_event_name);
  return {
    actorId: source,
    eventType: `${source}.${hookEventName}`,
    externalEventId: harnessExternalEventId(input, hookEventName, source),
    occurredAt: now.toISOString(),
    payload: { ...input },
    provenance: {
      ...(input.sagaManualIngest === true ? { sagaManualIngest: true } : {}),
      ...(input.manual === true ? { manual: true } : {}),
      ...(typeof input.captureMode === 'string' ? { captureMode: input.captureMode } : {}),
      ...(typeof input.ingestOrigin === 'string' ? { ingestOrigin: input.ingestOrigin } : {}),
      cwd: input.cwd,
      hookEventName,
      model: input.model,
      permissionMode: input.permission_mode,
      transcriptPath: input.transcript_path,
    },
    sessionId: input.session_id,
    sourceBindingId: binding.sourceBinding.id,
    sourceId: `${source}:local`,
    sourceType: source,
    traceId: input.turn_id,
    trustLevel: 'raw',
    workspaceId: binding.workspace.id,
  };
}

function normalizeHookEventName(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? 'unknown' : normalized;
}

function harnessExternalEventId(
  input: HarnessHookInput,
  hookEventName: string,
  source: HarnessSource,
): string {
  const stableParts = [
    source,
    hookEventName,
    input.session_id ?? '',
    input.turn_id ?? transcriptOccurrenceKey(input, source),
    input.transcript_path ?? '',
    stablePayloadHash(input),
  ];
  return stableParts.join(':');
}

function transcriptOccurrenceKey(input: HarnessHookInput, source: HarnessSource): string {
  if (source !== 'claude' || typeof input.transcript_path !== 'string') return '';
  if (!existsSync(input.transcript_path)) return '';

  const transcript = readFileSync(input.transcript_path, 'utf8');
  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
  const sessionId = input.session_id;
  const occurrences = transcript
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      try {
        const entry = JSON.parse(line) as unknown;
        return (
          isRecord(entry) &&
          entry.session_id === sessionId &&
          entry.type === 'user' &&
          (prompt === undefined || transcriptEntryText(entry) === prompt)
        );
      } catch {
        return false;
      }
    }).length;

  return occurrences === 0 ? '' : `transcript-${occurrences.toString()}`;
}

function transcriptEntryText(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.text === 'string') return entry.text;
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
    .join('');
}

function stablePayloadHash(input: HarnessHookInput): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
