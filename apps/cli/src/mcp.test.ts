import { describe, expect, test } from "vitest";
import { runMcpCommand } from "./mcp.js";

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
});
