import { describe, expect, test } from "vitest";
import {
  redactResolvedSagaLink,
  rewriteResolvedSagaLinkReferences,
  runMcpCommand,
  searchMemoryEntries,
  type MemorySearchEntry,
} from "./mcp.js";

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
    expect(output[0]).toContain("resolve_saga_link");
    expect(output[0]).toContain("list_recent_sessions");
    expect(output[0]).toContain("search_sessions");
    expect(output[0]).toContain("get_session_context");
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
    expect(output[0]).toContain("list_recent_sessions");
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

describe("rewriteResolvedSagaLinkReferences", () => {
  test("rewrites resolved connector references through workspace Context Index entries", async () => {
    const rewritten = await rewriteResolvedSagaLinkReferences(
      {
        externalId: "notes/architecture.md",
        metadata: {
          content: "Architecture note",
          references: [
            {
              externalId: "notes/adr.md",
              title: "ADR",
              url: "file:///vault/notes/adr.md",
            },
            {
              externalId: "notes/adr.md",
              sourceBindingId: "source-2",
              title: "Other ADR",
              url: "file:///other-vault/notes/adr.md",
            },
          ],
        },
        sourceBinding: {
          id: "source-1",
          sourceType: "norn",
          sourceUri: "norn://workspace",
        },
      },
      [
        {
          externalId: "notes/adr.md",
          sagaLink: "saga:context/adr",
          sourceBinding: {
            id: "source-1",
            sourceType: "vault",
          },
        },
      ],
    );

    expect(rewritten.references[0]).toMatchObject({
      originalUrl: "file:///vault/notes/adr.md",
      sagaLink: "saga:context/adr",
      sourceBindingId: "source-1",
      url: "saga:context/adr",
    });
    expect(rewritten.references[1]).toEqual({
      connector: "norn",
      externalId: "notes/adr.md",
      sourceBindingId: "source-2",
      title: "Other ADR",
      url: "file:///other-vault/notes/adr.md",
    });
  });

  test("uses metadata-only retrieval by default for MCP link resolution", async () => {
    const rewritten = await rewriteResolvedSagaLinkReferences(
      {
        externalId: "pr:12",
        metadata: {},
        sourceBinding: {
          config: {
            repositoryFullName: "dbtlr/saga",
            token: "secret-token",
          },
          id: "github-source",
          sourceType: "github",
          sourceUri: "github://dbtlr/saga",
        },
      },
      [],
    );

    expect(rewritten).toMatchObject({
      content: "",
      evidence: {
        contentAvailable: false,
        maxContentBytes: 65536,
        source: "metadata",
      },
      target: {
        apiUrl: "https://api.github.com/repos/dbtlr/saga/pulls/12",
        url: "https://github.com/dbtlr/saga/pull/12",
      },
    });
    expect(JSON.stringify(rewritten)).not.toContain("secret-token");
  });

  test("caps metadata content returned through MCP link resolution", async () => {
    const rewritten = await rewriteResolvedSagaLinkReferences(
      {
        externalId: "notes/large.md",
        metadata: {
          content: `${"a".repeat(65535)}éextra`,
        },
        sourceBinding: {
          id: "vault-source",
          sourceType: "vault",
          sourceUri: "file:///vault",
        },
      },
      [],
    );

    expect(Buffer.byteLength(rewritten.content ?? "", "utf8")).toBeLessThanOrEqual(65536);
    expect(rewritten.content).not.toContain("extra");
    expect(rewritten.evidence).toMatchObject({
      contentAvailable: true,
      maxContentBytes: 65536,
      source: "metadata",
      truncated: true,
    });
  });
});

describe("redactResolvedSagaLink", () => {
  test("omits source binding config from MCP structured results", () => {
    const redacted = redactResolvedSagaLink({
      entry: {
        externalId: "pr:12",
        key: "review-pr",
        sagaLink: "saga:context/review-pr",
        sourceBinding: {
          config: {
            authToken: "secret-token",
          },
          displayName: "GitHub",
          enabled: true,
          id: "github-source",
          sourceType: "github",
          sourceUri: "github://dbtlr/saga",
        },
        title: "Review PR",
      },
      provenance: {
        sourceBindingId: "github-source",
      },
    });

    expect(redacted.entry.sourceBinding).toEqual({
      displayName: "GitHub",
      enabled: true,
      id: "github-source",
      sourceType: "github",
      sourceUri: "github://dbtlr/saga",
    });
    expect(JSON.stringify(redacted)).not.toContain("config");
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
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
      {
        confidence: 0.9,
        fields: {
          connector: "vault",
          description: "Seed architecture note.",
          externalId: "notes/saga-v2-architecture-seed.md",
          sagaLink: "saga:context/architecture-seed",
          title: "Architecture Seed",
        },
        key: "saga:context/architecture-seed",
        kind: "context_index",
        source: "context_index",
        state: "always",
        text: "Architecture Seed",
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
      snippet: expect.stringContaining("search provenance"),
      source: "recent_activity",
    });
    expect(searchMemoryEntries({ query: "promoted decisions" }, entries)[0]).toMatchObject({
      key: "active-context:Current Claims:0",
      matchedFields: ["line"],
      source: "active_context",
    });
    const contextIndexMatch = searchMemoryEntries({ query: "architecture seed" }, entries)[0];
    expect(contextIndexMatch).toMatchObject({
      key: "saga:context/architecture-seed",
      sagaLink: "saga:context/architecture-seed",
      source: "context_index",
    });
    expect(contextIndexMatch?.matchedFields).toContain("title");
  });
});
