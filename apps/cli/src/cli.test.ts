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

  test("leaves command-specific options for command handlers", () => {
    expect(parseArgs(["sessions", "recent", "--limit", "5"])).toMatchObject({
      args: ["recent", "--limit", "5"],
      command: "sessions",
    });
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
      "sessions",
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

  test("dispatches start through the start handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "context",
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async () => "init",
      mcp: async () => "mcp",
      service: async () => "service",
      sessions: async () => "sessions",
      start: async (_args, _options, write) => {
        write("start launched");
        return 0;
      },
    };

    await expect(run(["start"], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toEqual(["start launched"]);
  });

  test("dispatches init through the init handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "context",
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async (args) => `init ${args.join(",")}`,
      mcp: async () => "mcp",
      service: async () => "service",
      sessions: async () => "sessions",
      start: async () => 0,
    };

    await expect(run(["init", "custom"], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toEqual(["init custom"]);
  });

  test("dispatches doctor through the doctor handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "context",
      doctor: async () => "doctor ok",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async () => "init",
      mcp: async () => "mcp",
      service: async () => "service",
      sessions: async () => "sessions",
      start: async () => 0,
    };

    await expect(run(["doctor"], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toEqual(["doctor ok"]);
  });

  test("dispatches service through the service handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "context",
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async () => "init",
      mcp: async () => "mcp",
      service: async (args) => `service ${args.join(",")}`,
      sessions: async () => "sessions",
      start: async () => 0,
    };

    await expect(run(["service", "status"], (text) => output.push(text), handlers)).resolves.toBe(
      0,
    );
    expect(output).toEqual(["service status"]);
  });

  test("dispatches harness through the harness handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "context",
      doctor: async () => "doctor",
      harness: async (args) => `harness ${args.join(",")}`,
      ingest: async () => "ingest",
      init: async () => "init",
      mcp: async () => "mcp",
      service: async () => "service",
      sessions: async () => "sessions",
      start: async () => 0,
    };

    await expect(
      run(["harness", "install", "codex"], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toEqual(["harness install,codex"]);
  });

  test("dispatches ingest through the ingest handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "context",
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async (args) => `ingest ${args.join(",")}`,
      init: async () => "init",
      mcp: async () => "mcp",
      service: async () => "service",
      sessions: async () => "sessions",
      start: async () => 0,
    };

    await expect(
      run(["ingest", "codex-hook"], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toEqual(["ingest codex-hook"]);
  });

  test("dispatches sessions through the sessions handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "context",
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async () => "init",
      mcp: async () => "mcp",
      service: async () => "service",
      sessions: async (args) => `sessions ${args.join(",")}`,
      start: async () => 0,
    };

    await expect(
      run(["sessions", "recent", "--limit", "5"], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toEqual(["sessions recent,--limit,5"]);
  });

  test("dispatches context through the context handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "compiled context",
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async () => "init",
      mcp: async () => "mcp",
      service: async () => "service",
      sessions: async () => "sessions",
      start: async () => 0,
    };

    await expect(run(["context"], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toEqual(["compiled context"]);
  });

  test("dispatches mcp through the streaming mcp handler", async () => {
    const output: string[] = [];
    const handlers: CommandHandlers = {
      context: async () => "context",
      doctor: async () => "doctor",
      harness: async () => "harness",
      ingest: async () => "ingest",
      init: async () => "init",
      mcp: async (_args, _options, write) => {
        write("mcp response");
        return undefined;
      },
      service: async () => "service",
      sessions: async () => "sessions",
      start: async () => 0,
    };

    await expect(run(["mcp"], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toEqual(["mcp response"]);
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
