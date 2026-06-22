import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import postgres from "postgres";
import { initProject } from "./init.js";
import { createProjectMcpServer } from "./mcp.js";
import { runSessionsCommand } from "./sessions.js";

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const renderOptions = {
  ascii: true,
  color: "never",
  format: "records",
  isTty: false,
} as const;

describePostgres("MCP session recall postgres integration", () => {
  const databaseName = `saga_mcp_recall_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? "", { max: 1 });
  let previousDatabaseUrl: string | undefined;
  let projectRoot: string | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? "");
    url.pathname = `/${databaseName}`;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    projectRoot = mkdtempSync(join(tmpdir(), "saga-mcp-recall-"));
    await initProject({ cwd: projectRoot, handle: "MCP Recall" });
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test("lists, searches, and expands imported session context through MCP tools", async () => {
    if (projectRoot === undefined) throw new Error("project root was not initialized");
    const inputPath = join(projectRoot, "mcp-session.jsonl");
    const linuxCwd = "/work/saga";
    const linuxProjectRoot = "/home/drew/work/saga";
    const linuxTranscriptPath = "/work/saga/mcp-session.jsonl";
    const customRoot = "/custom-root/saga";
    const fileUri = "file:///tmp/saga/session.jsonl";
    const linuxUnsafePaths = [
      linuxCwd,
      linuxProjectRoot,
      linuxTranscriptPath,
      customRoot,
      fileUri,
    ] as const;
    writeFileSync(
      inputPath,
      [
        JSON.stringify({
          text: `MCP recall sentinel phrase for SGA-130 search with imported path evidence ${linuxCwd} ${linuxProjectRoot} ${customRoot} ${fileUri} kept around plain words`,
          type: "user",
        }),
        JSON.stringify({
          text: `The assistant response provides MCP surrounding context from ${customRoot}/session.log and ${fileUri} with non-sensitive summary intact`,
          type: "assistant",
        }),
        "",
      ].join("\n"),
    );

    await runSessionsCommand(
      [
        "import",
        inputPath,
        "--harness",
        "codex",
        "--harness-session-id",
        "mcp-recall-session",
        "--host-project-root",
        linuxProjectRoot,
        "--metadata",
        JSON.stringify({ cwd: linuxCwd, note: `cwd=${linuxCwd}` }),
        "--provenance",
        JSON.stringify({ transcriptPath: linuxTranscriptPath }),
      ],
      renderOptions,
      { cwd: projectRoot },
    );

    const server = createProjectMcpServer({ cwd: projectRoot });
    const recent = await server.handle({
      id: "recent",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          limit: 5,
        },
        name: "list_recent_sessions",
      },
    });
    const recentResult = recent?.result as ToolResult | undefined;
    expect(recentResult?.content[0]?.text).toContain("Recent Saga Sessions");
    expect(recentResult?.content[0]?.text).toContain("mcp-recall-session");
    expect(recentResult?.content[0]?.text).toContain("Host user");
    expect(recentResult?.content[0]?.text).not.toContain(inputPath);
    expect(recentResult?.content[0]?.text).not.toContain(projectRoot);
    for (const unsafePath of linuxUnsafePaths) {
      expect(recentResult?.content[0]?.text).not.toContain(unsafePath);
    }
    expectNoUnsafeMcpStructuredContent(recentResult?.structuredContent, {
      extraPaths: linuxUnsafePaths,
      inputPath,
      projectRoot,
    });

    const search = await server.handle({
      id: "search",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          query: "imported path evidence",
        },
        name: "search_sessions",
      },
    });
    const searchResult = search?.result as ToolResult | undefined;
    expect(searchResult?.content[0]?.text).toContain("Saga Session Search");
    expect(searchResult?.content[0]?.text).toContain("Mode: lexical-only");
    expect(searchResult?.content[0]?.text).toContain("imported path evidence");
    expect(searchResult?.content[0]?.text).toContain("[local-path-redacted]");
    expect(searchResult?.content[0]?.text).toContain("Retrieved Content");
    expect(searchResult?.content[0]?.text).not.toContain(inputPath);
    expect(searchResult?.content[0]?.text).not.toContain(projectRoot);
    for (const unsafePath of linuxUnsafePaths) {
      expect(searchResult?.content[0]?.text).not.toContain(unsafePath);
    }
    expectNoUnsafeMcpStructuredContent(searchResult?.structuredContent, {
      extraPaths: linuxUnsafePaths,
      inputPath,
      projectRoot,
    });

    const segmentId = firstSegmentId(searchResult?.structuredContent);
    expect(segmentId).toMatch(/[0-9a-f-]{36}/u);

    const context = await server.handle({
      id: "context",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          segmentId,
          windowTurns: 1,
        },
        name: "get_session_context",
      },
    });
    const contextResult = context?.result as ToolResult | undefined;
    expect(contextResult?.content[0]?.text).toContain("Saga Session Context");
    expect(contextResult?.content[0]?.text).toContain("Segment 0 anchor");
    expect(contextResult?.content[0]?.text).toContain("MCP recall sentinel");
    expect(contextResult?.content[0]?.text).toContain("MCP surrounding context");
    expect(contextResult?.content[0]?.text).toContain("imported path evidence");
    expect(contextResult?.content[0]?.text).toContain("non-sensitive summary intact");
    expect(contextResult?.content[0]?.text).not.toContain(inputPath);
    expect(contextResult?.content[0]?.text).not.toContain(projectRoot);
    for (const unsafePath of linuxUnsafePaths) {
      expect(contextResult?.content[0]?.text).not.toContain(unsafePath);
    }
    expectNoUnsafeMcpStructuredContent(contextResult?.structuredContent, {
      extraPaths: linuxUnsafePaths,
      inputPath,
      projectRoot,
    });
  });
});

interface ToolResult {
  content: Array<{
    text: string;
    type: "text";
  }>;
  structuredContent: unknown;
}

function firstSegmentId(structuredContent: unknown): string {
  if (!isRecord(structuredContent)) return "";
  const sessions = structuredContent.sessions;
  if (!Array.isArray(sessions)) return "";
  const firstSession = sessions[0];
  if (!isRecord(firstSession)) return "";
  const matches = firstSession.matches;
  if (!Array.isArray(matches)) return "";
  const firstMatch = matches[0];
  if (!isRecord(firstMatch)) return "";
  const segment = firstMatch.segment;
  if (!isRecord(segment)) return "";
  return typeof segment.id === "string" ? segment.id : "";
}

function expectNoUnsafeMcpStructuredContent(
  structuredContent: unknown,
  input: { extraPaths?: readonly string[]; inputPath: string; projectRoot: string },
) {
  const serialized = JSON.stringify(structuredContent);
  for (const unsafePath of [input.inputPath, input.projectRoot, ...(input.extraPaths ?? [])]) {
    expect(serialized).not.toContain(unsafePath);
  }
  expect(serialized).not.toContain("sourceLocator");
  expect(serialized).not.toContain('"config"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
