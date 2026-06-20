import { renderActiveContextMarkdown } from "@saga/active-context";
import { createSagaMcpServer, type JsonRpcRequest, type SearchMemoryInput } from "@saga/mcp";
import {
  listActiveContextClaims,
  listCurrentClaims,
  listRecentRawEvents,
  makeDatabase,
} from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { compileActiveContextFromDatabase, compileProjectActiveContext } from "./context.js";
import { findProjectRoot, readBindingFile } from "./init.js";
import { type RenderOptions } from "./render.js";

export interface MemorySearchEntry {
  confidence: number;
  fields: Record<string, string>;
  key: string;
  kind: string;
  source: string;
  state: string;
  text: string;
}

export interface RankedMemorySearchMatch {
  confidence: number;
  key: string;
  kind: string;
  matchedFields: string[];
  score: number;
  snippet: string;
  source: string;
  state: string;
  text: string;
}

export async function runMcpCommand(
  _args: readonly string[],
  _options: RenderOptions,
  write: (text: string) => void,
  stdin: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string | undefined> {
  const server = createProjectMcpServer();
  for await (const line of readJsonLines(stdin)) {
    try {
      const response = await server.handle(parseJsonRpcRequest(line));
      if (response !== undefined) write(JSON.stringify(response));
    } catch (error) {
      write(JSON.stringify(jsonRpcInputError(error)));
    }
  }
  return undefined;
}

export function createProjectMcpServer(input: { cwd?: string } = {}) {
  const cwd = input.cwd;
  return createSagaMcpServer({
    getActiveContext: async () => {
      const document = await compileProjectActiveContext(cwd === undefined ? {} : { cwd });
      return {
        document,
        markdown: renderActiveContextMarkdown(document),
      };
    },
    searchMemory: (search) => searchProjectMemory(search, cwd === undefined ? {} : { cwd }),
  });
}

export async function searchProjectMemory(
  input: SearchMemoryInput,
  options: { cwd?: string } = {},
) {
  const projectRoot = findProjectRoot(options.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error("workspace binding is missing; run saga init");
  }

  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    const [claims, activeContextClaims, recentEvents] = await Promise.all([
      Effect.runPromise(
        listCurrentClaims(service, {
          limit: 100,
          workspaceId: binding.workspace.id,
        }),
      ),
      Effect.runPromise(
        listActiveContextClaims(service, {
          limit: 20,
          workspaceId: binding.workspace.id,
        }),
      ),
      Effect.runPromise(
        listRecentRawEvents(service, {
          limit: 50,
          workspaceId: binding.workspace.id,
        }),
      ),
    ]);
    const activeContext = await compileActiveContextFromDatabase(service, binding.workspace);
    const matches = searchMemoryEntries(input, [
      ...claims.map((claim): MemorySearchEntry => {
        const evidence = JSON.stringify(claim.evidence);
        const attributes = JSON.stringify(claim.attributes);
        return {
          confidence: claim.confidence,
          fields: {
            attributes,
            evidence,
            key: claim.claimKey,
            kind: claim.claimKind,
            state: claim.state,
            text: claim.claimText,
          },
          key: claim.claimKey,
          kind: claim.claimKind,
          source: "current_claim",
          state: claim.state,
          text: claim.claimText,
        };
      }),
      ...recentEvents.map(
        (event): MemorySearchEntry => ({
          confidence: event.trustLevel === "trusted" ? 0.8 : 0.45,
          fields: {
            actor: event.actorId ?? "",
            event: event.eventType,
            externalEventId: event.externalEventId,
            payload: JSON.stringify(event.payload),
            provenance: JSON.stringify(event.provenance),
            session: event.sessionId ?? "",
            source: `${event.sourceType}:${event.sourceId}`,
            trace: event.traceId ?? "",
          },
          key: event.id,
          kind: "raw_event",
          source: "recent_activity",
          state: event.trustLevel ?? "raw",
          text: `${event.sourceType}.${event.eventType.replace(/^[^.]+[.]/, "")} ${event.externalEventId}`,
        }),
      ),
      ...activeContext.sections.flatMap((section) =>
        section.lines.map(
          (line, index): MemorySearchEntry => ({
            confidence: 1,
            fields: {
              line,
              provenance: section.provenance.join(" "),
              section: section.title,
            },
            key: `active-context:${section.title}:${index.toString()}`,
            kind: "active_context",
            source: "active_context",
            state: "compiled",
            text: `${section.title}: ${line}`,
          }),
        ),
      ),
      ...activeContextClaims.map(
        (claim): MemorySearchEntry => ({
          confidence: claim.confidence,
          fields: {
            key: claim.claimKey,
            kind: claim.claimKind,
            state: claim.state,
            text: claim.claimText,
          },
          key: `active-context-claim:${claim.claimKey}`,
          kind: claim.claimKind,
          source: "active_context_input",
          state: claim.state,
          text: claim.claimText,
        }),
      ),
    ]);

    return {
      markdown: renderSearchMemoryMarkdown(input.query, matches),
      matches: matches.map(({ score: _score, ...match }) => match),
    };
  } finally {
    await Effect.runPromise(service.close());
  }
}

export function searchMemoryEntries(
  input: SearchMemoryInput,
  entries: readonly MemorySearchEntry[],
): RankedMemorySearchMatch[] {
  const tokens = tokenize(input.query);
  if (tokens.length === 0) return [];

  return entries
    .map((entry) => rankMemoryEntry(entry, tokens))
    .filter((match): match is RankedMemorySearchMatch => match !== undefined)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.confidence - left.confidence ||
        left.text.localeCompare(right.text),
    )
    .slice(0, input.limit ?? 10);
}

function rankMemoryEntry(
  entry: MemorySearchEntry,
  tokens: readonly string[],
): RankedMemorySearchMatch | undefined {
  const fieldMatches = Object.entries(entry.fields).flatMap(([field, value]) => {
    const normalized = value.toLowerCase();
    const hits = tokens.filter((token) => normalized.includes(token)).length;
    return hits === 0 ? [] : [{ field, hits, value }];
  });
  if (fieldMatches.length === 0) return undefined;

  const matchedFields = [...new Set(fieldMatches.map((match) => match.field))];
  const bestFieldMatch = fieldMatches
    .slice()
    .sort((left, right) => right.hits - left.hits || left.field.localeCompare(right.field))[0];
  const exactTextBonus = tokens.every((token) => entry.text.toLowerCase().includes(token)) ? 4 : 0;
  const weightedHits = fieldMatches.reduce((score, match) => score + match.hits, 0);
  const sourceWeight = sourceSearchWeight(entry.source);
  return {
    confidence: entry.confidence,
    key: entry.key,
    kind: entry.kind,
    matchedFields,
    score: weightedHits + exactTextBonus + sourceWeight + entry.confidence,
    snippet: matchedSnippet(bestFieldMatch?.value ?? entry.text, tokens),
    source: entry.source,
    state: entry.state,
    text: entry.text,
  };
}

function renderSearchMemoryMarkdown(
  query: string,
  matches: readonly RankedMemorySearchMatch[],
): string {
  if (matches.length === 0) return `# Saga Memory Search\n\nNo matches for ${query}.`;

  return [
    "# Saga Memory Search",
    "",
    ...matches.map(
      (match) =>
        `- [${match.source}/${match.state}/${match.kind}] ${match.text} (${Math.round(match.confidence * 100).toString()}%; matched ${match.matchedFields.join(", ")}): ${match.snippet}`,
    ),
  ].join("\n");
}

function matchedSnippet(value: string, tokens: readonly string[]): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized === "") return "";

  const lower = normalized.toLowerCase();
  const firstHit = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (firstHit === undefined) return truncateSnippet(normalized);

  const start = Math.max(0, firstHit - 48);
  const end = Math.min(normalized.length, firstHit + 112);
  const prefix = start === 0 ? "" : "...";
  const suffix = end === normalized.length ? "" : "...";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function truncateSnippet(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}

function sourceSearchWeight(source: string): number {
  if (source === "current_claim") return 2;
  if (source === "active_context") return 1.5;
  if (source === "active_context_input") return 1;
  return 0;
}

function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_:-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    ),
  ];
}

async function* readJsonLines(stdin: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed !== "") yield trimmed;
    }
  }
  const trimmed = buffer.trim();
  if (trimmed !== "") yield trimmed;
}

function parseJsonRpcRequest(line: string): JsonRpcRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    throw new Error("expected a JSON-RPC 2.0 request object");
  }
  if (
    parsed.id !== undefined &&
    typeof parsed.id !== "string" &&
    typeof parsed.id !== "number" &&
    parsed.id !== null
  ) {
    throw new Error("JSON-RPC request id must be a string, number, or null");
  }
  return {
    id: parsed.id,
    jsonrpc: "2.0",
    method: parsed.method,
    params: parsed.params,
  };
}

function jsonRpcInputError(error: unknown) {
  return {
    error: {
      code: error instanceof SyntaxError ? -32700 : -32600,
      message: error instanceof Error ? error.message : String(error),
    },
    id: null,
    jsonrpc: "2.0",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
