import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  importLifecycleBoundaryEvent,
  importRawSessionRecord,
  listRecentRawEvents,
  makeDatabase,
  type ClaimProjectionResult,
  type LifecycleBoundaryInput,
  type LifecycleBoundaryOperation,
  type RawEvent,
  type RawSessionContentType,
  type RawSessionImportInput,
} from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { findProjectRoot, readBindingFile, type WorkspaceBindingFileWithHost } from "./init.js";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";

export interface HookIngestResult {
  accepted: boolean;
  error?: string | undefined;
  eventId?: string | undefined;
  lifecycleBoundary?: LifecycleBoundaryOperation | "skipped" | undefined;
  mode: "captured" | "skipped";
  rawSessionImport?: "inserted" | "skipped" | "unchanged" | undefined;
  rawSessionRecordId?: string | undefined;
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
          ...(result.rawSessionImport === undefined
            ? []
            : [{ label: "raw session import", value: result.rawSessionImport }]),
          ...(result.rawSessionRecordId === undefined
            ? []
            : [{ label: "raw session record", value: result.rawSessionRecordId }]),
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
    if (binding.host === undefined || binding.host.id.trim() === "") {
      throw new Error(
        `${sourceDisplayName(source)} harness binding is stale: local host id is missing`,
      );
    }
    const bindingWithHost = binding as WorkspaceBindingFileWithHost;

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
      try {
        const rawSessionImportInput = buildAmbientRawSessionImportInput({
          binding: bindingWithHost,
          hookCwd: input.cwd,
          hookInput: input,
          projectRoot,
          rawEventId: row.id,
          rawEventOccurredAt: row.occurredAt,
          source,
          sourceBindingId: sourceBinding.sourceBindingId,
        });
        if (rawSessionImportInput === undefined) {
          let lifecycleBoundary: LifecycleBoundaryOperation | "skipped" = "skipped";
          try {
            const lifecycle = await Effect.runPromise(
              importLifecycleBoundaryEvent(
                service,
                buildLifecycleBoundaryInput({
                  binding: bindingWithHost,
                  hookInput: input,
                  projectRoot,
                  rawEventId: row.id,
                  rawEventOccurredAt: row.occurredAt,
                  source,
                  sourceBindingId: sourceBinding.sourceBindingId,
                }),
              ),
            );
            lifecycleBoundary = lifecycle.operation;
          } catch (lifecycleError) {
            return {
              accepted: true,
              error: boundedErrorMessage(lifecycleError),
              eventId: row.id,
              lifecycleBoundary: "skipped",
              mode: "captured",
              rawSessionImport: "skipped",
              source,
            };
          }
          return {
            accepted: true,
            eventId: row.id,
            lifecycleBoundary,
            mode: "captured",
            rawSessionImport: "skipped",
            source,
          };
        }
        const rawSessionImport = await Effect.runPromise(
          importRawSessionRecord(service, rawSessionImportInput),
        );
        return {
          accepted: true,
          eventId: row.id,
          mode: "captured",
          rawSessionImport: rawSessionImport.operation,
          rawSessionRecordId: rawSessionImport.rawSessionRecord.id,
          source,
        };
      } catch (error) {
        return {
          accepted: true,
          error: boundedErrorMessage(error),
          eventId: row.id,
          mode: "captured",
          rawSessionImport: "skipped",
          source,
        };
      }
    } finally {
      await Effect.runPromise(service.close());
    }
  } catch (error) {
    return {
      accepted: true,
      error: boundedErrorMessage(error),
      mode: "skipped",
      source,
    };
  }
}

function buildAmbientRawSessionImportInput(input: {
  binding: WorkspaceBindingFileWithHost;
  hookCwd?: string | undefined;
  hookInput: HarnessHookInput;
  projectRoot: string;
  rawEventId: string;
  rawEventOccurredAt: Date;
  source: HarnessSource;
  sourceBindingId: string;
}): RawSessionImportInput | undefined {
  const transcriptPath =
    typeof input.hookInput.transcript_path === "string" &&
    input.hookInput.transcript_path.trim() !== ""
      ? input.hookInput.transcript_path
      : undefined;
  if (transcriptPath === undefined) return undefined;
  const resolvedTranscriptPath = isAbsolute(transcriptPath)
    ? transcriptPath
    : resolve(input.hookCwd ?? input.projectRoot, transcriptPath);
  if (!existsSync(resolvedTranscriptPath)) return undefined;

  const rawContent = readFileSync(resolvedTranscriptPath, "utf8");
  const hookEventName =
    typeof input.hookInput.hook_event_name === "string"
      ? input.hookInput.hook_event_name
      : undefined;
  const sessionStartSource =
    readHookString(input.hookInput.source) ?? readHookString(input.hookInput.session_start_source);
  const author = defaultAuthor();

  return {
    activity: {
      hookEventName,
      sessionStartSource,
      settlementTriggerRawEventId: input.rawEventId,
    },
    author,
    capturedAt: input.rawEventOccurredAt,
    contentType: inferSessionContentType(resolvedTranscriptPath, rawContent),
    harness: input.source,
    harnessMetadata: {
      hookEventName,
      permissionMode: readHookString(input.hookInput.permission_mode),
      sessionStartSource,
    },
    harnessSessionId: readHookString(input.hookInput.session_id),
    host: {
      id: input.binding.host.id,
      label: input.binding.host.label,
      projectRoot: input.projectRoot,
    },
    locator: pathToFileURL(resolvedTranscriptPath).href,
    metadata: {
      importMode: "ambient_hook",
      triggerRawEventId: input.rawEventId,
    },
    model: readHookString(input.hookInput.model),
    provenance: {
      hookEventName,
      importedBy: `saga ingest ${input.source}-hook`,
      rawEventId: input.rawEventId,
      transcriptPath: resolvedTranscriptPath,
    },
    rawContent,
    sourceBindingId: input.sourceBindingId,
    status: hookEventName === "Stop" ? "completed" : "active",
    workspaceId: input.binding.workspace.id,
  };
}

function buildLifecycleBoundaryInput(input: {
  binding: WorkspaceBindingFileWithHost;
  hookInput: HarnessHookInput;
  projectRoot: string;
  rawEventId: string;
  rawEventOccurredAt: Date;
  source: HarnessSource;
  sourceBindingId: string;
}): LifecycleBoundaryInput {
  const hookEventName =
    typeof input.hookInput.hook_event_name === "string"
      ? input.hookInput.hook_event_name
      : undefined;
  const sessionStartSource =
    readHookString(input.hookInput.source) ?? readHookString(input.hookInput.session_start_source);
  return {
    activity: { hookEventName, sessionStartSource, settlementTriggerRawEventId: input.rawEventId },
    author: defaultAuthor(),
    capturedAt: input.rawEventOccurredAt,
    harness: input.source,
    harnessMetadata: {
      hookEventName,
      permissionMode: readHookString(input.hookInput.permission_mode),
      sessionStartSource,
    },
    harnessSessionId: readHookString(input.hookInput.session_id),
    host: {
      id: input.binding.host.id,
      label: input.binding.host.label,
      projectRoot: input.projectRoot,
    },
    metadata: { importMode: "ambient_hook", triggerRawEventId: input.rawEventId },
    model: readHookString(input.hookInput.model),
    provenance: {
      hookEventName,
      importedBy: `saga ingest ${input.source}-hook`,
      rawEventId: input.rawEventId,
    },
    sourceBindingId: input.sourceBindingId,
    status: hookEventName === "Stop" ? "completed" : "active",
    workspaceId: input.binding.workspace.id,
  };
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

function inferSessionContentType(path: string, rawContent: string): RawSessionContentType {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".jsonl" || extension === ".ndjson") return "jsonl";

  const trimmed = rawContent.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return "json";
  if (trimmed.split(/\r?\n/u).every((line) => line.trim() === "" || line.trim().startsWith("{"))) {
    return "jsonl";
  }
  return "text";
}

function defaultAuthor(): RawSessionImportInput["author"] {
  const user = userInfo();
  return {
    displayName: user.username,
    handle: user.username,
    externalSubject: user.username,
  };
}

function readHookString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
