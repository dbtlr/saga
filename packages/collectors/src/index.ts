import { createHash } from "node:crypto";
import type { RawEventEnvelope } from "@saga/contracts";

export const packageName = "@saga/collectors";

export interface CodexHookInput {
  cwd?: string | undefined;
  hook_event_name?: string | undefined;
  model?: string | undefined;
  permission_mode?: string | undefined;
  session_id?: string | undefined;
  transcript_path?: string | null | undefined;
  turn_id?: string | undefined;
  [key: string]: unknown;
}

export interface CodexWorkspaceBinding {
  codexSourceBinding: {
    id: string;
  };
  workspace: {
    id: string;
  };
}

export function rawEventFromCodexHook(
  input: CodexHookInput,
  binding: CodexWorkspaceBinding,
  now = new Date(),
): RawEventEnvelope {
  const hookEventName = normalizeHookEventName(input.hook_event_name);
  return {
    actorId: "codex",
    eventType: `codex.${hookEventName}`,
    externalEventId: codexExternalEventId(input, hookEventName),
    occurredAt: now.toISOString(),
    payload: { ...input },
    provenance: {
      cwd: input.cwd,
      hookEventName,
      model: input.model,
      permissionMode: input.permission_mode,
      transcriptPath: input.transcript_path,
    },
    sessionId: input.session_id,
    sourceBindingId: binding.codexSourceBinding.id,
    sourceId: "codex:local",
    sourceType: "codex",
    traceId: input.turn_id,
    trustLevel: "raw",
    workspaceId: binding.workspace.id,
  };
}

function normalizeHookEventName(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? "unknown" : normalized;
}

function codexExternalEventId(input: CodexHookInput, hookEventName: string): string {
  const stableParts = [
    "codex",
    hookEventName,
    input.session_id ?? "",
    input.turn_id ?? "",
    input.transcript_path ?? "",
    stablePayloadHash(input),
  ];
  return stableParts.join(":");
}

function stablePayloadHash(input: CodexHookInput): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
