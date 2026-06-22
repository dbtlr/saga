import { existsSync, readFileSync } from "node:fs";
import { extractCandidateClaimsFromRawEvents } from "@saga/claims";
import {
  rawEventFromClaudeHook,
  rawEventFromCodexHook,
  type ClaudeHookInput,
  type CodexHookInput,
  type HarnessHookInput,
  type HarnessSource,
} from "@saga/collectors";
import {
  insertExtractedCandidateClaims,
  insertRawEvent,
  listRecentRawEvents,
  makeDatabase,
  type ClaimProjectionResult,
  type RawEvent,
} from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { findProjectRoot, readBindingFile } from "./init.js";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";

export interface HookIngestResult {
  accepted: boolean;
  error?: string | undefined;
  eventId?: string | undefined;
  mode: "captured" | "skipped";
  source: HarnessSource;
}

export type CodexHookIngestResult = HookIngestResult & { source: "codex" };
export type ClaudeHookIngestResult = HookIngestResult & { source: "claude" };

export interface IngestHookOptions {
  capture?: ((input: HarnessHookInput) => Promise<HookIngestResult>) | undefined;
  inputPath?: string | undefined;
  stdin?: string | undefined;
}

export interface ClaimIngestResult {
  candidates: number;
  projected: number;
  rawEvents: number;
}

export async function runIngestCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === "claude-hook") {
    return ingestHook("claude", options, { inputPath: args[1] });
  }

  if (subcommand === "codex-hook") {
    return ingestHook("codex", options, { inputPath: args[1] });
  }

  if (subcommand === "recent") {
    return inspectRecentRawEvents({ limit: parseLimit(args[1]) }, options);
  }

  if (subcommand === "claims") {
    return ingestClaims({ limit: parseLimit(args[1]) }, options);
  }

  throw new Error(`ingest ${subcommand ?? ""} is not implemented yet`.trim());
}

export async function ingestCodexHook(
  options: RenderOptions,
  input: IngestHookOptions = {},
): Promise<string> {
  return ingestHook("codex", options, input);
}

export async function ingestHook(
  source: HarnessSource,
  options: RenderOptions,
  input: IngestHookOptions = {},
): Promise<string> {
  const parsedHookInput = parseHookInput(await readHookInput(input));
  const hookInput =
    input.inputPath === undefined || input.inputPath === "-"
      ? parsedHookInput
      : markManualHookInput(source, parsedHookInput);
  const capture = input.capture ?? ((event) => captureHook(source, event));
  const result = await capture(hookInput);

  if (options.format === "records") {
    return JSON.stringify(
      result.error === undefined
        ? { continue: true }
        : {
            continue: true,
            systemMessage: `Saga ${sourceDisplayName(source)} capture skipped: ${result.error}`,
          },
    );
  }

  return formatCommandOutput(
    {
      id: source,
      records: recordBlock(
        `${sourceDisplayName(source)} hook ingest`,
        [
          { label: "source", value: result.source },
          { label: "mode", value: result.mode },
          { label: "accepted", value: String(result.accepted) },
          ...(result.eventId === undefined ? [] : [{ label: "event", value: result.eventId }]),
          ...(result.error === undefined ? [] : [{ label: "error", value: result.error }]),
        ],
        options,
      ),
      value: result,
    },
    options.format,
  );
}

export async function inspectRecentRawEvents(
  input: { cwd?: string; limit?: number | undefined },
  options: RenderOptions,
): Promise<string> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error("workspace binding is missing; run saga init");
  }

  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    const rows = await Effect.runPromise(
      listRecentRawEvents(service, {
        limit: input.limit,
        workspaceId: binding.workspace.id,
      }),
    );

    return formatCommandOutput(
      {
        id: "raw-events",
        records: renderRawEvents(rows, options),
        value: rows.map(rawEventValue),
      },
      options.format,
    );
  } finally {
    await Effect.runPromise(service.close());
  }
}

export async function ingestClaims(
  input: { cwd?: string; limit?: number | undefined },
  options: RenderOptions,
): Promise<string> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error("workspace binding is missing; run saga init");
  }

  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    const rawEvents = await Effect.runPromise(
      listRecentRawEvents(service, {
        limit: input.limit ?? 50,
        workspaceId: binding.workspace.id,
      }),
    );
    const candidates = extractCandidateClaimsFromRawEvents(rawEvents);
    const projections = await Effect.runPromise(
      insertExtractedCandidateClaims(service, candidates),
    );
    const result: ClaimIngestResult = {
      candidates: candidates.length,
      projected: projections.length,
      rawEvents: rawEvents.length,
    };

    return formatCommandOutput(
      {
        id: "claims",
        records: renderClaimIngest(result, projections, options),
        value: result,
      },
      options.format,
    );
  } finally {
    await Effect.runPromise(service.close());
  }
}

export async function captureCodexHook(input: CodexHookInput): Promise<CodexHookIngestResult> {
  return captureHook("codex", input) as Promise<CodexHookIngestResult>;
}

export async function captureClaudeHook(input: ClaudeHookInput): Promise<ClaudeHookIngestResult> {
  return captureHook("claude", input) as Promise<ClaudeHookIngestResult>;
}

export async function captureHook(
  source: HarnessSource,
  input: HarnessHookInput,
): Promise<HookIngestResult> {
  try {
    const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
    const binding = readBindingFile(projectRoot);
    if (binding === undefined) {
      throw new Error("workspace binding is missing; run saga init");
    }
    const sourceBinding = binding.harnesses?.[source];
    if (sourceBinding === undefined) {
      throw new Error(
        `${sourceDisplayName(source)} harness is not installed; run saga harness install ${source}`,
      );
    }
    if (
      typeof sourceBinding.sourceBindingId !== "string" ||
      sourceBinding.sourceBindingId.trim() === ""
    ) {
      throw new Error(
        `${sourceDisplayName(source)} harness binding is invalid: sourceBindingId is missing`,
      );
    }

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
    const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
    try {
      const event =
        source === "claude"
          ? rawEventFromClaudeHook(input, {
              sourceBinding: {
                id: sourceBinding.sourceBindingId,
              },
              workspace: binding.workspace,
            })
          : rawEventFromCodexHook(input, {
              codexSourceBinding: {
                id: sourceBinding.sourceBindingId,
              },
              workspace: binding.workspace,
            });
      const row = await Effect.runPromise(insertRawEvent(service, event));
      return {
        accepted: true,
        eventId: row.id,
        mode: "captured",
        source,
      };
    } finally {
      await Effect.runPromise(service.close());
    }
  } catch (error) {
    return {
      accepted: true,
      error: error instanceof Error ? error.message : String(error),
      mode: "skipped",
      source,
    };
  }
}

function renderClaimIngest(
  result: ClaimIngestResult,
  projections: readonly ClaimProjectionResult[],
  options: RenderOptions,
): string {
  return recordBlock(
    "Claim ingest",
    [
      { label: "raw events", value: String(result.rawEvents) },
      { label: "candidates", value: String(result.candidates) },
      { label: "projected", value: String(result.projected) },
      ...projections.slice(0, 5).map((projection, index) => ({
        label: `claim ${String(index + 1)}`,
        value: projection.currentClaim.claimText,
      })),
    ],
    options,
  );
}

function parseHookInput(stdin: string): HarnessHookInput {
  const trimmed = stdin.trim();
  if (trimmed === "") return {};
  const parsed = JSON.parse(trimmed) as unknown;
  return isRecord(parsed) ? parsed : { payload: parsed };
}

function markManualHookInput(source: HarnessSource, input: HarnessHookInput): HarnessHookInput {
  return {
    ...input,
    captureMode: "manual",
    ingestOrigin: `saga ingest ${source}-hook <file>`,
    manual: true,
    sagaManualIngest: true,
  };
}

async function readHookInput(input: IngestHookOptions): Promise<string> {
  if (input.stdin !== undefined) return input.stdin;
  if (input.inputPath !== undefined && input.inputPath !== "-") {
    if (!existsSync(input.inputPath)) {
      throw new Error(`input file not found: ${input.inputPath}`);
    }
    return readFileSync(input.inputPath, "utf8");
  }
  return readStdin();
}

function sourceDisplayName(source: HarnessSource): string {
  if (source === "claude") return "Claude Code";
  return "Codex";
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || String(limit) !== value) {
    throw new Error(`invalid raw event limit: ${value}`);
  }
  return limit;
}

function renderRawEvents(rows: readonly RawEvent[], options: RenderOptions): string {
  if (rows.length === 0) {
    return recordBlock("Raw events", [{ label: "events", value: "none" }], options);
  }

  const fields = rows.flatMap((row, index) => [
    { label: `event ${String(index + 1)}`, value: row.eventType },
    { label: "id", value: row.id },
    { label: "session", value: row.sessionId ?? "none" },
    { label: "occurred", value: row.occurredAt.toISOString() },
  ]);
  return recordBlock("Raw events", fields, options);
}

function rawEventValue(row: RawEvent): Record<string, unknown> {
  return {
    eventType: row.eventType,
    externalEventId: row.externalEventId,
    id: row.id,
    ingestedAt: row.ingestedAt.toISOString(),
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload,
    provenance: row.provenance,
    sessionId: row.sessionId,
    sourceId: row.sourceId,
    sourceType: row.sourceType,
    traceId: row.traceId,
    trustLevel: row.trustLevel,
    workspaceId: row.workspaceId,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
