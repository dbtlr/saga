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
  sourceBinding: {
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
    sourceId: binding.sourceBinding.id,
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
