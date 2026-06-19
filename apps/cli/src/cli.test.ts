import { describe, expect, test } from "vitest";
import { COMMANDS, HELP_TEXT, parseArgs, run, validateCommand } from "./cli.js";

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
  test("help lists reserved command groups", () => {
    expect(HELP_TEXT).toContain("service");
    expect(HELP_TEXT).toContain("harness");
    expect(Object.keys(COMMANDS)).toEqual([
      "init",
      "doctor",
      "start",
      "service",
      "harness",
      "mcp",
      "context",
      "ingest",
    ]);
  });

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
    expect(output).toEqual(["✗ unknown command: nope"]);
  });

  test("renders usage errors without glyphs in ascii mode", () => {
    const output: string[] = [];
    expect(run(["--ascii", "nope"], (text) => output.push(text))).toBe(2);
    expect(output).toEqual(["[err] unknown command: nope"]);
  });

  test("reserves known commands with placeholder behavior", () => {
    const output: string[] = [];
    expect(run(["doctor"], (text) => output.push(text))).toBe(1);
    expect(output).toEqual(["doctor is not implemented yet"]);
  });
});

describe("validateCommand", () => {
  test("requires reserved service subcommands", () => {
    expect(() =>
      validateCommand({
        args: [],
        command: "service",
        options: {
          ascii: false,
          color: "auto",
          format: "records",
          help: false,
          version: false,
        },
      }),
    ).toThrow("service: missing subcommand");
  });

  test("accepts reserved harness subcommands", () => {
    expect(() =>
      validateCommand({
        args: ["install", "codex"],
        command: "harness",
        options: {
          ascii: false,
          color: "auto",
          format: "records",
          help: false,
          version: false,
        },
      }),
    ).not.toThrow();
  });
});
