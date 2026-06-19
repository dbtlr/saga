import { describe, expect, test } from "vitest";
import type { CommandHandlers } from "./cli.js";
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

  test("prints help without a command", async () => {
    const output: string[] = [];
    await expect(run([], (text) => output.push(text))).resolves.toBe(0);
    expect(output).toEqual([HELP_TEXT.trimEnd()]);
  });

  test("prints version", async () => {
    const output: string[] = [];
    await expect(run(["--version"], (text) => output.push(text))).resolves.toBe(0);
    expect(output).toEqual(["saga 0.0.0"]);
  });

  test("reports unknown commands as usage errors", async () => {
    const output: string[] = [];
    await expect(run(["nope"], (text) => output.push(text))).resolves.toBe(2);
    expect(output).toEqual(["✗ unknown command: nope"]);
  });

  test("renders usage errors without glyphs in ascii mode", async () => {
    const output: string[] = [];
    await expect(run(["--ascii", "nope"], (text) => output.push(text))).resolves.toBe(2);
    expect(output).toEqual(["[err] unknown command: nope"]);
  });

  test("reserves known commands with placeholder behavior", async () => {
    const output: string[] = [];
    await expect(run(["doctor"], (text) => output.push(text))).resolves.toBe(1);
    expect(output).toEqual(["doctor is not implemented yet"]);
  });

  test("dispatches init through the init handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      init: async (args) => `init ${args.join(",")}`,
    };

    await expect(run(["init", "custom"], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toEqual(["init custom"]);
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
