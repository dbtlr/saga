import {
  createOpenAiSessionEmbeddingGenerator,
  expandRecallContext,
  makeDatabase,
  searchSessionRecall,
  type RecallContextExpansion,
  type RecallContextExpansionInput,
  type RecallExpandedSegment,
  type RecallExpandedTurn,
  type RecallQueryEmbedding,
  type RecallSearchInput,
  type RecallSearchResult,
  type RecallSegmentMatch,
} from "@saga/db";
import { loadRuntimeConfig, resolveCodexAuth } from "@saga/runtime";
import { Effect } from "effect";
import { type WorkspaceBindingFile, findProjectRoot, readBindingFile } from "./init.js";
import { formatCommandOutput } from "./output.js";
import { recordBlock, separator, type RenderOptions } from "./render.js";

const SEARCH_FLAGS_WITH_VALUES = new Set([
  "activity",
  "activity-interval",
  "activity-interval-id",
  "limit",
  "min-trigram",
  "raw",
  "raw-record",
  "raw-session-record",
  "raw-session-record-id",
  "session",
  "session-id",
  "vector-candidates",
  "workspace",
  "workspace-id",
]);
const SEARCH_BOOLEAN_FLAGS = new Set(["no-embeddings"]);
const SHOW_FLAGS_WITH_VALUES = new Set(["after", "before", "window", "workspace", "workspace-id"]);
const SHOW_BOOLEAN_FLAGS = new Set<string>();

export interface RecallCommandDependencies {
  cwd?: string | undefined;
  expandContext?:
    | ((input: RecallContextExpansionInput) => Promise<RecallContextExpansion>)
    | undefined;
  resolveQueryEmbedding?:
    | ((query: string) => Promise<RecallQueryEmbedding | undefined>)
    | undefined;
  searchRecall?: ((input: RecallSearchInput) => Promise<RecallSearchResult>) | undefined;
}

export async function runRecallCommand(
  args: readonly string[],
  options: RenderOptions,
  dependencies: RecallCommandDependencies = {},
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === "search") {
    return searchRecallCommand(args.slice(1), options, dependencies);
  }
  if (subcommand === "show") {
    return showRecallCommand(args.slice(1), options, dependencies);
  }
  throw new Error(`recall ${subcommand ?? ""} is not implemented yet`.trim());
}

async function searchRecallCommand(
  args: readonly string[],
  options: RenderOptions,
  dependencies: RecallCommandDependencies,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: SEARCH_BOOLEAN_FLAGS,
    flagsWithValues: SEARCH_FLAGS_WITH_VALUES,
  });
  const query = parsed.positionals.join(" ").trim();
  if (query === "") {
    throw new Error("recall search requires a query: saga recall search <query>");
  }

  const project = loadBoundProject(dependencies.cwd);
  const workspaceId = workspaceIdFromFlags(parsed.flags, project.binding);
  const baseInput: RecallSearchInput = {
    activityIntervalId: firstFlag(parsed.flags, [
      "activity-interval-id",
      "activity-interval",
      "activity",
    ]),
    limit: parsePositiveIntegerFlag(parsed.flags.limit, "limit"),
    minTrigramScore: parseScoreFlag(parsed.flags["min-trigram"], "min-trigram"),
    query,
    rawSessionRecordId: firstFlag(parsed.flags, [
      "raw-session-record-id",
      "raw-session-record",
      "raw-record",
      "raw",
    ]),
    sessionId: firstFlag(parsed.flags, ["session-id", "session"]),
    vectorCandidateLimit: parsePositiveIntegerFlag(
      parsed.flags["vector-candidates"],
      "vector-candidates",
    ),
    workspaceId,
  };

  const queryEmbedding = parsed.booleans.has("no-embeddings")
    ? undefined
    : dependencies.resolveQueryEmbedding !== undefined || dependencies.searchRecall === undefined
      ? await resolveQueryEmbedding(query, dependencies)
      : undefined;
  const input: RecallSearchInput =
    queryEmbedding === undefined ? baseInput : { ...baseInput, queryEmbedding };

  const result =
    dependencies.searchRecall === undefined
      ? await withDatabase(project.projectRoot, async (service) =>
          Effect.runPromise(searchSessionRecall(service, input)),
        )
      : await dependencies.searchRecall(input);

  return formatCommandOutput(
    {
      id: result.sessions
        .flatMap((group) => group.matches.map((match) => match.segment.id))
        .join("\n"),
      records: renderRecallSearch(result, options),
      value: result,
    },
    options.format,
  );
}

async function showRecallCommand(
  args: readonly string[],
  options: RenderOptions,
  dependencies: RecallCommandDependencies,
): Promise<string> {
  const parsed = parseLocalOptions(args, {
    booleanFlags: SHOW_BOOLEAN_FLAGS,
    flagsWithValues: SHOW_FLAGS_WITH_VALUES,
  });
  const segmentId = parsed.positionals[0];
  if (segmentId === undefined) {
    throw new Error("recall show requires a segment id: saga recall show <segment-id>");
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`recall show received unexpected argument: ${parsed.positionals[1]}`);
  }

  const project = loadBoundProject(dependencies.cwd);
  const input: RecallContextExpansionInput = {
    segmentId,
    windowTurns: parseWindowTurns(parsed.flags),
    workspaceId: workspaceIdFromFlags(parsed.flags, project.binding),
  };
  const result =
    dependencies.expandContext === undefined
      ? await withDatabase(project.projectRoot, async (service) =>
          Effect.runPromise(expandRecallContext(service, input)),
        )
      : await dependencies.expandContext(input);

  return formatCommandOutput(
    {
      id: result.anchor.segment.id,
      records: renderRecallContext(result, options),
      value: result,
    },
    options.format,
  );
}

interface BoundProject {
  binding: WorkspaceBindingFile;
  projectRoot: string;
}

function loadBoundProject(cwd: string | undefined): BoundProject {
  const projectRoot = findProjectRoot(cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error("workspace binding is missing; run saga init");
  }
  return { binding, projectRoot };
}

async function withDatabase<T>(
  projectRoot: string,
  runWithService: (service: Awaited<ReturnType<typeof openDatabase>>) => Promise<T>,
): Promise<T> {
  const service = await openDatabase(projectRoot);
  try {
    return await runWithService(service);
  } finally {
    await Effect.runPromise(service.close());
  }
}

async function openDatabase(projectRoot: string) {
  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  return Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
}

async function resolveQueryEmbedding(
  query: string,
  dependencies: RecallCommandDependencies,
): Promise<RecallQueryEmbedding | undefined> {
  if (dependencies.resolveQueryEmbedding !== undefined) {
    return dependencies.resolveQueryEmbedding(query);
  }

  const auth = resolveCodexAuth();
  if (auth.status !== "available") return undefined;

  const generator = createOpenAiSessionEmbeddingGenerator({ apiKey: auth.openaiApiKey });
  try {
    const [output] = await generator.embedSegments([
      {
        inputHash: "query",
        segmentId: "query",
        text: query,
      },
    ]);
    if (output === undefined) return undefined;
    return {
      dimensions: generator.provider.dimensions,
      model: generator.provider.model,
      provider: generator.provider.id,
      vector: output.embedding,
    };
  } catch {
    return undefined;
  }
}

function renderRecallSearch(result: RecallSearchResult, options: RenderOptions): string {
  const blocks = [
    recordBlock(
      "Recall Search",
      [
        { label: "query", value: result.query },
        { label: "workspace", value: result.workspaceId },
        { label: "matches", value: String(result.matchCount) },
        { label: "searched", value: result.searchedAt },
      ],
      options,
    ),
  ];

  if (result.matchCount === 0) {
    blocks.push(recordBlock("Matches", [{ label: "segments", value: "none" }], options));
    return blocks.join(`\n${separator(options)}\n`);
  }

  let matchIndex = 1;
  for (const sessionGroup of result.sessions) {
    blocks.push(
      recordBlock(
        "Session",
        [
          { label: "session", value: sessionGroup.session.id },
          { label: "title", value: sessionGroup.session.title ?? "none" },
          { label: "harness", value: sessionGroup.session.harness },
          { label: "harness session", value: sessionGroup.session.harnessSessionId ?? "none" },
          { label: "model", value: sessionGroup.session.model ?? "none" },
          { label: "host-user", value: sessionGroup.session.authorUser.handle },
          { label: "source locator", value: sessionGroup.session.sourceLocator ?? "none" },
          { label: "last activity", value: formatDate(sessionGroup.session.lastActivityAt) },
          { label: "metadata", value: compactJson(sessionGroup.session.metadata) },
          { label: "provenance", value: compactJson(sessionGroup.session.provenance) },
        ],
        options,
      ),
    );

    for (const intervalGroup of sessionGroup.activityIntervals) {
      blocks.push(
        recordBlock(
          `Activity Interval ${String(intervalGroup.activityInterval.ordinal)}`,
          [
            { label: "id", value: intervalGroup.activityInterval.id },
            { label: "status", value: intervalGroup.activityInterval.status },
            { label: "started", value: formatDate(intervalGroup.activityInterval.startedAt) },
            { label: "ended", value: formatDate(intervalGroup.activityInterval.endedAt) },
            { label: "matches", value: String(intervalGroup.matches.length) },
            { label: "metadata", value: compactJson(intervalGroup.activityInterval.metadata) },
          ],
          options,
        ),
      );

      for (const match of intervalGroup.matches) {
        blocks.push(renderMatch(match, matchIndex, options));
        matchIndex += 1;
      }
    }
  }

  return blocks.join(`\n${separator(options)}\n`);
}

function renderMatch(
  match: RecallSegmentMatch,
  matchIndex: number,
  options: RenderOptions,
): string {
  return recordBlock(
    `Match ${String(matchIndex)}`,
    [
      { label: "segment", value: match.segment.id },
      { label: "turn", value: `${String(match.turn.ordinal)} ${match.turn.role} ${match.turn.id}` },
      { label: "raw record", value: match.rawSessionRecord.id },
      { label: "kind", value: match.segment.segmentKind },
      { label: "scores", value: formatScores(match.scores) },
      { label: "tokens", value: formatRange(match.segment.tokenStart, match.segment.tokenEnd) },
      { label: "chars", value: formatRange(match.segment.charStart, match.segment.charEnd) },
      { label: "snippet", value: stripTsHeadline(match.snippet) },
      { label: "raw metadata", value: compactJson(match.rawSessionRecord.metadata) },
      { label: "raw provenance", value: compactJson(match.rawSessionRecord.provenance) },
      { label: "source", value: match.sourceBinding.sourceUri },
    ],
    options,
  );
}

function renderRecallContext(result: RecallContextExpansion, options: RenderOptions): string {
  const blocks = [
    recordBlock(
      "Recall Context",
      [
        { label: "workspace", value: result.workspaceId },
        { label: "window", value: `${String(result.windowTurns)} turns` },
        { label: "anchor segment", value: result.anchor.segment.id },
        { label: "anchor turn", value: result.anchor.turn.id },
        { label: "session", value: result.session.id },
        { label: "Activity Interval", value: result.activityInterval.id },
        { label: "raw record", value: result.rawSessionRecord.id },
      ],
      options,
    ),
    recordBlock(
      "Session",
      [
        { label: "title", value: result.session.title ?? "none" },
        { label: "harness", value: result.session.harness },
        { label: "harness session", value: result.session.harnessSessionId ?? "none" },
        { label: "model", value: result.session.model ?? "none" },
        { label: "host-user", value: result.session.authorUser.handle },
        { label: "status", value: result.session.status },
        { label: "started", value: formatDate(result.session.startedAt) },
        { label: "last activity", value: formatDate(result.session.lastActivityAt) },
        { label: "metadata", value: compactJson(result.session.metadata) },
        { label: "provenance", value: compactJson(result.session.provenance) },
      ],
      options,
    ),
    recordBlock(
      "Source",
      [
        { label: "source", value: result.sourceBinding.sourceUri },
        { label: "type", value: result.sourceBinding.sourceType },
        { label: "enabled", value: String(result.sourceBinding.enabled) },
        { label: "metadata", value: compactJson(result.sourceBinding.config) },
      ],
      options,
    ),
    recordBlock(
      "Raw Session Record",
      [
        { label: "id", value: result.rawSessionRecord.id },
        { label: "snapshot", value: String(result.rawSessionRecord.snapshotOrdinal) },
        { label: "active", value: String(result.rawSessionRecord.isActive) },
        { label: "status", value: result.rawSessionRecord.status },
        { label: "harness", value: result.rawSessionRecord.harness },
        { label: "harness session", value: result.rawSessionRecord.harnessSessionId ?? "none" },
        { label: "locator", value: result.rawSessionRecord.sourceLocator ?? "none" },
        { label: "captured", value: formatDate(result.rawSessionRecord.capturedAt) },
        { label: "content", value: result.rawSessionRecord.contentType },
        { label: "hash", value: result.rawSessionRecord.contentHash },
        { label: "metadata", value: compactJson(result.rawSessionRecord.metadata) },
        { label: "provenance", value: compactJson(result.rawSessionRecord.provenance) },
      ],
      options,
    ),
    recordBlock(
      `Activity Interval ${String(result.activityInterval.ordinal)}`,
      [
        { label: "id", value: result.activityInterval.id },
        { label: "status", value: result.activityInterval.status },
        { label: "started", value: formatDate(result.activityInterval.startedAt) },
        { label: "ended", value: formatDate(result.activityInterval.endedAt) },
        { label: "settled", value: formatDate(result.activityInterval.settledAt) },
        { label: "settlement", value: result.activityInterval.settlementReason ?? "none" },
        { label: "metadata", value: compactJson(result.activityInterval.metadata) },
      ],
      options,
    ),
  ];

  for (const turn of result.turns) {
    blocks.push(renderExpandedTurn(turn, result.anchor.segment.id, options));
  }

  return blocks.join(`\n${separator(options)}\n`);
}

function renderExpandedTurn(
  turn: RecallExpandedTurn,
  anchorSegmentId: string,
  options: RenderOptions,
): string {
  const blocks = [
    recordBlock(
      `Turn ${String(turn.ordinal)}`,
      [
        { label: "id", value: turn.id },
        { label: "role", value: turn.role },
        { label: "actor", value: `${turn.actorKind}:${turn.actorLabel ?? "none"}` },
        { label: "harness turn", value: turn.harnessTurnId ?? "none" },
        { label: "model", value: turn.model ?? "none" },
        { label: "started", value: formatDate(turn.startedAt) },
        { label: "ended", value: formatDate(turn.endedAt) },
        { label: "parts", value: compactJson(turn.contentParts) },
        {
          label: "raw events",
          value: turn.rawEventIds.length === 0 ? "none" : turn.rawEventIds.join(", "),
        },
        { label: "raw span", value: compactJson(turn.rawSpan) },
        { label: "metadata", value: compactJson(turn.metadata) },
      ],
      options,
    ),
  ];

  for (const segment of turn.segments) {
    blocks.push(renderExpandedSegment(segment, segment.id === anchorSegmentId, options));
  }

  return blocks.join(`\n${separator(options)}\n`);
}

function renderExpandedSegment(
  segment: RecallExpandedSegment,
  isAnchor: boolean,
  options: RenderOptions,
): string {
  return recordBlock(
    `Segment ${String(segment.ordinal)}${isAnchor ? " anchor" : ""}`,
    [
      { label: "id", value: segment.id },
      { label: "kind", value: segment.segmentKind },
      { label: "tokens", value: formatRange(segment.tokenStart, segment.tokenEnd) },
      { label: "chars", value: formatRange(segment.charStart, segment.charEnd) },
      { label: "snippet", value: segment.snippet ?? "none" },
      { label: "text", value: truncate(segment.searchText, 360) },
      { label: "metadata", value: compactJson(segment.metadata) },
    ],
    options,
  );
}

interface LocalOptions {
  booleans: Set<string>;
  flags: Record<string, string>;
  positionals: string[];
}

function parseLocalOptions(
  args: readonly string[],
  spec: { booleanFlags: ReadonlySet<string>; flagsWithValues: ReadonlySet<string> },
): LocalOptions {
  const booleans = new Set<string>();
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const name = rawName ?? "";
    if (spec.booleanFlags.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not take a value`);
      booleans.add(name);
      continue;
    }
    if (!spec.flagsWithValues.has(name)) {
      throw new Error(`unknown recall option: --${name}`);
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined) throw new Error(`--${name} expects a value`);
    flags[name] = value;
    if (inlineValue === undefined) index += 1;
  }

  return { booleans, flags, positionals };
}

function parsePositiveIntegerFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`--${label} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeIntegerFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`--${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseScoreFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--${label} must be between 0 and 1`);
  }
  return parsed;
}

function parseWindowTurns(flags: Record<string, string>): number | undefined {
  const windowTurns = parseNonNegativeIntegerFlag(flags.window, "window");
  const before = parseNonNegativeIntegerFlag(flags.before, "before");
  const after = parseNonNegativeIntegerFlag(flags.after, "after");
  if (windowTurns === undefined && before === undefined && after === undefined) return undefined;
  return Math.max(windowTurns ?? 0, before ?? 0, after ?? 0);
}

function workspaceIdFromFlags(
  flags: Record<string, string>,
  binding: WorkspaceBindingFile,
): string {
  return flags["workspace-id"] ?? flags.workspace ?? binding.workspace.id;
}

function firstFlag(flags: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function formatScores(scores: RecallSegmentMatch["scores"]): string {
  const parts = [
    `combined ${formatScore(scores.combined)}`,
    `lexical ${formatScore(scores.lexical)}`,
    `trigram ${formatScore(scores.trigram)}`,
  ];
  if (scores.vector !== undefined) parts.push(`vector ${formatScore(scores.vector)}`);
  return parts.join(", ");
}

function formatScore(value: number): string {
  return value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function compactJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? "undefined" : truncate(json, 220);
}

function formatDate(value: Date | string | null): string {
  if (value === null) return "none";
  return value instanceof Date ? value.toISOString() : value;
}

function formatRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return "none";
  return `${start === null ? "?" : String(start)}..${end === null ? "?" : String(end)}`;
}

function stripTsHeadline(value: string): string {
  return value.replaceAll(/<\/?b>/g, "");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
