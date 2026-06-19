import { describe, expect, test } from "vitest";
import { createSagaMcpServer } from "./index.js";

const server = createSagaMcpServer({
  getActiveContext: async () => ({
    document: { summary: "Active Context for saga" },
    markdown: "# Active Context for saga",
  }),
  searchMemory: async (input) => ({
    markdown: `# Search\n${input.query}`,
    matches: [
      {
        confidence: 0.9,
        key: "claim-key",
        kind: "decision",
        state: "candidate",
        text: `Found ${input.query}`,
      },
    ],
  }),
});

describe("createSagaMcpServer", () => {
  test("lists Saga MCP tools", async () => {
    const response = await server.handle({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
    });

    expect(response?.result).toMatchObject({
      tools: [
        {
          name: "get_active_context",
        },
        {
          name: "search_memory",
        },
      ],
    });
  });

  test("calls get_active_context", async () => {
    const response = await server.handle({
      id: "context",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "get_active_context",
      },
    });

    expect(response?.result).toMatchObject({
      content: [
        {
          text: "# Active Context for saga",
          type: "text",
        },
      ],
      structuredContent: {
        summary: "Active Context for saga",
      },
    });
  });

  test("calls search_memory", async () => {
    const response = await server.handle({
      id: "search",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          query: "Active Context",
        },
        name: "search_memory",
      },
    });

    expect(JSON.stringify(response?.result)).toContain("Found Active Context");
  });

  test("returns JSON-RPC errors", async () => {
    const response = await server.handle({
      id: 99,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: "search_memory",
      },
    });

    expect(response?.error?.message).toBe("search_memory requires a non-empty query");
  });
});
