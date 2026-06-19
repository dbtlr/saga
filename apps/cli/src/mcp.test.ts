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
});
