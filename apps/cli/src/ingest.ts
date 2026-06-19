import { existsSync, readFileSync } from "node:fs";
import { rawEventFromCodexHook, type CodexHookInput } from "@saga/collectors";
import { insertRawEvent, listRecentRawEvents, makeDatabase, type RawEvent } from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { findProjectRoot, readBindingFile } from "./init.js";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";

export interface CodexHookIngestResult {
  accepted: boolean;
  error?: string | undefined;
  eventId?: string | undefined;
  mode: "captured" | "skipped";
  source: "codex";
}

export interface IngestCodexHookOptions {
  capture?: ((input: CodexHookInput) => Promise<CodexHookIngestResult>) | undefined;
  inputPath?: string | undefined;
  stdin?: string | undefined;
}

export async function runIngestCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === "codex-hook") {
    return ingestCodexHook(options, { inputPath: args[1] });
  }

  if (subcommand === "recent") {
    return inspectRecentRawEvents({ limit: parseLimit(args[1]) }, options);
  }

  throw new Error(`ingest ${subcommand ?? ""} is not implemented yet`.trim());
}

export async function ingestCodexHook(
  options: RenderOptions,
  input: IngestCodexHookOptions = {},
): Promise<string> {
  const hookInput = parseCodexHookInput(await readCodexHookInput(input));
  const capture = input.capture ?? captureCodexHook;
  const result = await capture(hookInput);

  if (options.format === "records") {
    return JSON.stringify(
      result.error === undefined
        ? { continue: true }
        : { continue: true, systemMessage: `Saga Codex capture skipped: ${result.error}` },
    );
  }

  return formatCommandOutput(
    {
      id: "codex",
      records: recordBlock(
        "Codex hook ingest",
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

export async function captureCodexHook(input: CodexHookInput): Promise<CodexHookIngestResult> {
  try {
    const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
    const binding = readBindingFile(projectRoot);
    if (binding === undefined) {
      throw new Error("workspace binding is missing; run saga init");
    }
    const codexSourceBinding = binding.harnesses?.codex;
    if (codexSourceBinding === undefined) {
      throw new Error("Codex harness is not installed; run saga harness install codex");
    }

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
    const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
    try {
      const event = rawEventFromCodexHook(input, {
        codexSourceBinding: {
          id: codexSourceBinding.sourceBindingId,
        },
        workspace: binding.workspace,
      });
      const row = await Effect.runPromise(insertRawEvent(service, event));
      return {
        accepted: true,
        eventId: row.id,
        mode: "captured",
        source: "codex",
      };
    } finally {
      await Effect.runPromise(service.close());
    }
  } catch (error) {
    return {
      accepted: true,
      error: error instanceof Error ? error.message : String(error),
      mode: "skipped",
      source: "codex",
    };
  }
}

function parseCodexHookInput(stdin: string): CodexHookInput {
  const trimmed = stdin.trim();
  if (trimmed === "") return {};
  const parsed = JSON.parse(trimmed) as unknown;
  return isRecord(parsed) ? parsed : { payload: parsed };
}

async function readCodexHookInput(input: IngestCodexHookOptions): Promise<string> {
  if (input.stdin !== undefined) return input.stdin;
  if (input.inputPath !== undefined && input.inputPath !== "-") {
    if (!existsSync(input.inputPath)) {
      throw new Error(`input file not found: ${input.inputPath}`);
    }
    return readFileSync(input.inputPath, "utf8");
  }
  return readStdin();
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
