import { rawEventFromCodexHook, type CodexHookInput } from "@saga/collectors";
import { insertRawEvent, makeDatabase } from "@saga/db";
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
  stdin?: string | undefined;
}

export async function runIngestCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === "codex-hook") {
    return ingestCodexHook(options);
  }

  throw new Error(`ingest ${subcommand ?? ""} is not implemented yet`.trim());
}

export async function ingestCodexHook(
  options: RenderOptions,
  input: IngestCodexHookOptions = {},
): Promise<string> {
  const hookInput = parseCodexHookInput(input.stdin ?? (await readStdin()));
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

export async function captureCodexHook(input: CodexHookInput): Promise<CodexHookIngestResult> {
  try {
    const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
    const binding = readBindingFile(projectRoot);
    if (binding === undefined) {
      throw new Error("workspace binding is missing; run saga init");
    }

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
    const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
    try {
      const event = rawEventFromCodexHook(input, binding);
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
