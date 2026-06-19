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
    await expect(run(["context"], (text) => output.push(text))).resolves.toBe(1);
    expect(output).toEqual(["context is not implemented yet"]);
  });

  test("dispatches init through the init handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async (args) => `init ${args.join(",")}`,
      service: async () => "service",
    };

    await expect(run(["init", "custom"], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toEqual(["init custom"]);
  });

  test("dispatches doctor through the doctor handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      doctor: async () => "doctor ok",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async () => "init",
      service: async () => "service",
    };

    await expect(run(["doctor"], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toEqual(["doctor ok"]);
  });

  test("dispatches service through the service handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async () => "init",
      service: async (args) => `service ${args.join(",")}`,
    };

    await expect(run(["service", "status"], (text) => output.push(text), handlers)).resolves.toBe(
      0,
    );
    expect(output).toEqual(["service status"]);
  });

  test("unimplemented service subcommands fail", async () => {
    const output: string[] = [];

    await expect(run(["service", "start"], (text) => output.push(text))).resolves.toBe(1);
    expect(output).toEqual(["✗ service start is not implemented yet"]);
  });

  test("dispatches harness through the harness handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      doctor: async () => "doctor",
      harness: async (args) => `harness ${args.join(",")}`,
      ingest: async () => "ingest",
      init: async () => "init",
      service: async () => "service",
    };

    await expect(
      run(["harness", "install", "codex"], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toEqual(["harness install,codex"]);
  });

  test("dispatches ingest through the ingest handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async (args) => `ingest ${args.join(",")}`,
      init: async () => "init",
      service: async () => "service",
    };

    await expect(
      run(["ingest", "codex-hook"], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toEqual(["ingest codex-hook"]);
  });

  test("implemented commands can render structured output", async () => {
    const output: string[] = [];

    await expect(
      run(["--format", "json", "service", "status"], (text) => output.push(text)),
    ).resolves.toBe(0);
    expect(() => JSON.parse(output[0] ?? "")).not.toThrow();
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
