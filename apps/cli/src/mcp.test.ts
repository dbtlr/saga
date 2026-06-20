import { describe, expect, test } from "vitest";
import { runMcpCommand, searchMemoryEntries, type MemorySearchEntry } from "./mcp.js";

async function* chunks(text: string) {
  yield text;
}

describe("runMcpCommand", () => {
  test("responds to newline-delimited JSON-RPC requests", async () => {
    const output: string[] = [];

    await runMcpCommand(
      [],
      { ascii: true, color: "never", format: "records", isTty: false },
      (text) => output.push(text),
      chunks(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" })}\n`),
    );

    expect(output).toHaveLength(1);
    expect(output[0]).toContain("get_active_context");
    expect(output[0]).toContain("search_memory");
  });

  test("streams a response before stdin closes", async () => {
    const output: string[] = [];
    let release: (() => void) | undefined;
    async function* openStream() {
      yield `${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" })}\n`;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }

    const running = runMcpCommand(
      [],
      { ascii: true, color: "never", format: "records", isTty: false },
      (text) => output.push(text),
      openStream(),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output[0]).toContain("get_active_context");
    release?.();
    await running;
  });

  test("returns JSON-RPC parse errors for malformed frames", async () => {
    const output: string[] = [];

    await runMcpCommand(
      [],
      { ascii: true, color: "never", format: "records", isTty: false },
      (text) => output.push(text),
      chunks("not-json\n"),
    );

    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      error: {
        code: -32700,
      },
      id: null,
      jsonrpc: "2.0",
    });
  });

  test("returns JSON-RPC invalid request errors for invalid ids", async () => {
    const output: string[] = [];

    await runMcpCommand(
      [],
      { ascii: true, color: "never", format: "records", isTty: false },
      (text) => output.push(text),
      chunks(`${JSON.stringify({ id: {}, jsonrpc: "2.0", method: "tools/list" })}\n`),
    );

    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      error: {
        code: -32600,
        message: "JSON-RPC request id must be a string, number, or null",
      },
      id: null,
      jsonrpc: "2.0",
    });
  });
});

describe("searchMemoryEntries", () => {
  test("ranks matches across claims, recent activity, and Active Context lines", () => {
    const entries: MemorySearchEntry[] = [
      {
        confidence: 0.72,
        fields: {
          evidence: '{"quote":"Use typed route contracts for MCP calls"}',
          text: "Control plane should expose governance actions.",
        },
        key: "claim-1",
        kind: "decision",
        source: "current_claim",
        state: "supported",
        text: "Control plane should expose governance actions.",
      },
      {
        confidence: 0.45,
        fields: {
          payload: '{"prompt":"Investigate missing search provenance in MCP results"}',
          provenance: '{"transcriptPath":"/tmp/session.jsonl"}',
        },
        key: "raw-1",
        kind: "raw_event",
        source: "recent_activity",
        state: "raw",
        text: "codex.UserPromptSubmit codex:turn-1",
      },
      {
        confidence: 1,
        fields: {
          line: "Current Claims: Active Context should include promoted decisions.",
          provenance: "claim:claim-2",
          section: "Current Claims",
        },
        key: "active-context:Current Claims:0",
        kind: "active_context",
        source: "active_context",
        state: "compiled",
        text: "Current Claims: Active Context should include promoted decisions.",
      },
    ];

    expect(searchMemoryEntries({ query: "typed route" }, entries)[0]).toMatchObject({
      key: "claim-1",
      matchedFields: ["evidence"],
      source: "current_claim",
    });
    expect(searchMemoryEntries({ query: "search session" }, entries)[0]).toMatchObject({
      key: "raw-1",
      matchedFields: ["payload", "provenance"],
      source: "recent_activity",
    });
    expect(searchMemoryEntries({ query: "promoted decisions" }, entries)[0]).toMatchObject({
      key: "active-context:Current Claims:0",
      matchedFields: ["line"],
      source: "active_context",
    });
  });
});
