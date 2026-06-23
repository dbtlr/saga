import { describe, expect, test } from "vitest";
import {
  redactMcpStructuredOutput,
  redactResolvedSagaLink,
  redactSearchMemoryStructuredMatches,
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

describe("redactMcpStructuredOutput", () => {
  test("removes unsafe locator keys and redacts local path values", () => {
    const redacted = redactMcpStructuredOutput({
      rawSessionRecord: {
        id: "raw-1",
        metadata: {
          capturedText:
            "Use /work/saga, /home/drew/work/saga, /custom-root/saga, C:\\Users\\drew\\.codex\\transcripts\\session.jsonl, and file:///tmp/saga/session.jsonl but keep https://example.com/docs/path and saga:context/workflow.",
          embedded: "cwd=/work/saga log=/custom-root/saga/session.log",
          genericInputPath: "/custom-root/saga/session.jsonl",
          inputPath: "/Volumes/data/workspaces/saga/session.jsonl",
          linuxInputPath: "/work/saga/session.jsonl",
          nested: {
            sourceLocator: "file:///Volumes/data/workspaces/saga/session.jsonl",
          },
          nonLocalId: "github/dbtlr/saga",
          pseudoSchemes: "cwd:/work/saga log:/custom-root/saga/session.log",
          referenceUrl: "https://example.com/docs/path?target=saga",
          safeGithubUri: "github://dbtlr/saga/pull/12",
          safeMimirUri: "mimir://project/SGA-130",
          safeNornUri: "norn://workspace/notes/saga",
          sagaLink: "saga:context/workflow",
          sourceLocatorHash: "sha256:local-path-hash",
        },
        provenance: {
          homeProjectRoot: "/home/drew/work/saga",
          projectRoot: "/Users/drew/work/saga",
          transcript:
            "loaded from file:///tmp/saga/session.jsonl cwd=/work/saga windows=C:\\Users\\drew\\.codex\\transcripts\\session.jsonl",
          windowsTranscriptPath: "C:\\Users\\drew\\.codex\\transcripts\\session.jsonl",
        },
        sourceLocator: "file:///Volumes/data/workspaces/saga/session.jsonl",
      },
      session: {
        id: "session-1",
        sourceLocator: "file:///Volumes/data/workspaces/saga/session.jsonl",
      },
      sourceBinding: {
        config: {
          token: "secret-token",
        },
        displayName: "Codex",
        enabled: true,
        id: "source-1",
        sourceType: "codex",
        sourceUri: "codex://local",
      },
      target: {
        apiUrl: "https://api.github.com/repos/dbtlr/saga/pulls/12",
        sourceUri: "codex://local/session/abc",
      },
    });

    expect(redacted).toMatchObject({
      rawSessionRecord: {
        id: "raw-1",
        metadata: {
          capturedText:
            "Use [local-path-redacted], [local-path-redacted], [local-path-redacted], [local-path-redacted], and [local-path-redacted] but keep https://example.com/docs/path and saga:context/workflow.",
          embedded: "cwd=[local-path-redacted] log=[local-path-redacted]",
          genericInputPath: "[local-path-redacted]",
          inputPath: "[local-path-redacted]",
          linuxInputPath: "[local-path-redacted]",
          nested: {},
          nonLocalId: "github/dbtlr/saga",
          pseudoSchemes: "cwd:[local-path-redacted] log:[local-path-redacted]",
          referenceUrl: "https://example.com/docs/path?target=saga",
          safeGithubUri: "github://dbtlr/saga/pull/12",
          safeMimirUri: "mimir://project/SGA-130",
          safeNornUri: "norn://workspace/notes/saga",
          sagaLink: "saga:context/workflow",
        },
        provenance: {
          homeProjectRoot: "[local-path-redacted]",
          projectRoot: "[local-path-redacted]",
          transcript:
            "loaded from [local-path-redacted] cwd=[local-path-redacted] windows=[local-path-redacted]",
          windowsTranscriptPath: "[local-path-redacted]",
        },
      },
      session: {
        id: "session-1",
      },
      sourceBinding: {
        displayName: "Codex",
        enabled: true,
        id: "source-1",
        sourceType: "codex",
        sourceUri: "codex://local",
      },
      target: {
        apiUrl: "https://api.github.com/repos/dbtlr/saga/pulls/12",
        sourceUri: "codex://local/session/abc",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("sourceLocator");
    expect(JSON.stringify(redacted)).not.toContain("config");
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("/Volumes/data/workspaces/saga");
    expect(JSON.stringify(redacted)).not.toContain("/Users/drew/work/saga");
    expect(JSON.stringify(redacted)).not.toContain("/home/drew/work/saga");
    expect(JSON.stringify(redacted)).not.toContain("/work/saga");
    expect(JSON.stringify(redacted)).not.toContain("/custom-root/saga");
    expect(JSON.stringify(redacted)).not.toContain("C:\\\\Users\\\\drew");
    expect(JSON.stringify(redacted)).not.toContain("file:///tmp/saga/session.jsonl");
  });

  test("preserves explicit raw forensic body fields when warning metadata is present", () => {
    const redacted = redactMcpStructuredOutput({
      rawSessionRecord: {
        bodyJson: {
          path: "/work/saga/raw-session.jsonl",
          text: "skipped-secret-needle",
        },
        bodyText: "raw body from /work/saga/raw-session.jsonl skipped-secret-needle",
        id: "raw-1",
        metadata: {
          capturedText: "safe metadata path /work/saga/session.jsonl",
        },
        rawBodyExposure: {
          mode: "raw_forensic",
          requestedBy: "includeRawBody",
          warning:
            "Explicit raw forensic access: bodyText/bodyJson are persisted raw session bodies and may include skipped, omitted, local, or sensitive content that normal Saga surfaces hide.",
        },
        sourceLocator: "file:///work/saga/raw-session.jsonl",
      },
    });

    expect(redacted).toMatchObject({
      rawSessionRecord: {
        bodyJson: {
          path: "/work/saga/raw-session.jsonl",
          text: "skipped-secret-needle",
        },
        bodyText: "raw body from /work/saga/raw-session.jsonl skipped-secret-needle",
        metadata: {
          capturedText: "safe metadata path [local-path-redacted]",
        },
        rawBodyExposure: {
          mode: "raw_forensic",
          requestedBy: "includeRawBody",
        },
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("sourceLocator");
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

  test("redacts local paths from structured search memory matches", () => {
    const matches = searchMemoryEntries({ query: "transcript" }, [
      {
        confidence: 0.45,
        fields: {
          payload: '{"prompt":"inspect transcript"}',
          provenance:
            '{"transcriptPath":"C:\\\\Users\\\\Drew Smith\\\\.codex\\\\transcripts\\\\session.jsonl","unc":"\\\\\\\\server\\\\share\\\\Users\\\\drew\\\\.codex\\\\transcripts\\\\session.jsonl","safe":"https://example.test/session"}',
        },
        key: "raw-structured",
        kind: "raw_event",
        source: "recent_activity",
        state: "raw",
        text: "codex.UserPromptSubmit /Users/Drew Smith/.codex/transcripts/session.jsonl https://example.test/session",
      },
    ]);

    const structured = redactSearchMemoryStructuredMatches(matches);
    expect(JSON.stringify(structured)).toContain("[local-path-redacted]");
    expect(JSON.stringify(structured)).toContain("https://example.test/session");
    expect(JSON.stringify(structured)).not.toContain("/Users/Drew Smith");
    expect(JSON.stringify(structured)).not.toContain("C:\\\\Users\\\\Drew Smith");
    expect(JSON.stringify(structured)).not.toContain("\\\\\\\\server\\\\share");
    expect(structured[0]).not.toHaveProperty("score");
  });
});
