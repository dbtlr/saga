import { describe, expect, test } from "vitest";
import { HELP_TEXT, parseArgs, run } from "./cli.js";

describe("parseArgs", () => {
  test("parses global flags and command arguments", () => {
    expect(
      parseArgs(["--format", "json", "--color", "never", "--ascii", "context", "preview"]),
    ).toEqual({
      args: ["preview"],
      command: "context",
      options: {
        ascii: true,
        color: "never",
        format: "json",
        help: false,
        version: false,
      },
    });
  });

  test("rejects unknown options", () => {
    expect(() => parseArgs(["--bad"])).toThrow("unknown option: --bad");
  });
});

describe("run", () => {
  test("prints help without a command", () => {
    const output: string[] = [];
    expect(run([], (text) => output.push(text))).toBe(0);
    expect(output).toEqual([HELP_TEXT.trimEnd()]);
  });

  test("prints version", () => {
    const output: string[] = [];
    expect(run(["--version"], (text) => output.push(text))).toBe(0);
    expect(output).toEqual(["saga 0.0.0"]);
  });

  test("reports unknown commands as usage errors", () => {
    const output: string[] = [];
    expect(run(["nope"], (text) => output.push(text))).toBe(2);
    expect(output).toEqual(["error: unknown command: nope"]);
  });
});
