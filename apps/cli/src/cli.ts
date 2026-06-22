import { runContextCommand } from "./context.js";
import { runDoctor } from "./doctor.js";
import { runHarnessCommand } from "./harness.js";
import { runIngestCommand } from "./ingest.js";
import { runInit } from "./init.js";
import { runMcpCommand } from "./mcp.js";
import { runServiceCommand } from "./service.js";
import { runSessionsCommand } from "./sessions.js";
import { runStartCommand } from "./start.js";
import { errorLine, renderOptionsFromGlobals } from "./render.js";

export type OutputFormat = "records" | "json" | "jsonl" | "ids";
export type ColorMode = "auto" | "always" | "never";

export interface GlobalOptions {
  ascii: boolean;
  color: ColorMode;
  format: OutputFormat;
  help: boolean;
  version: boolean;
}

export interface ParsedCommand {
  args: string[];
  command: string | undefined;
  options: GlobalOptions;
}

export interface CommandDefinition {
  description: string;
  subcommands?: readonly string[];
}

export const COMMANDS = {
  init: { description: "bind this project to a Saga Workspace" },
  doctor: { description: "inspect local environment and Saga state" },
  start: { description: "launch local Saga service and control plane" },
  service: {
    description: "run or manage the Saga runtime service",
    subcommands: ["run", "install", "uninstall", "start", "stop", "restart", "status"],
  },
  harness: {
    description: "install or inspect harness integrations",
    subcommands: ["install", "uninstall", "status"],
  },
  mcp: { description: "launch the stdio MCP adapter" },
  context: { description: "preview compiled Active Context" },
  ingest: {
    description: "manually ingest source data for debugging",
    subcommands: ["claude-hook", "codex-hook", "recent", "claims"],
  },
  sessions: {
    description: "import and inspect raw session records",
    subcommands: ["import", "recent", "show"],
  },
} as const satisfies Record<string, CommandDefinition>;

export type CommandName = keyof typeof COMMANDS;

const OUTPUT_FORMATS = new Set<OutputFormat>(["records", "json", "jsonl", "ids"]);
const COLOR_MODES = new Set<ColorMode>(["auto", "always", "never"]);

const DEFAULT_OPTIONS: GlobalOptions = {
  ascii: false,
  color: "auto",
  format: "records",
  help: false,
  version: false,
};

export class UsageError extends Error {
  readonly code = "usage";

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const VERSION = "0.0.0";

export interface CommandHandlers {
  doctor: typeof runDoctor;
  context: typeof runContextCommand;
  harness: typeof runHarnessCommand;
  ingest: typeof runIngestCommand;
  init: typeof runInit;
  mcp: typeof runMcpCommand;
  service: typeof runServiceCommand;
  sessions: typeof runSessionsCommand;
  start: typeof runStartCommand;
}

export const DEFAULT_HANDLERS: CommandHandlers = {
  context: runContextCommand,
  doctor: runDoctor,
  harness: runHarnessCommand,
  ingest: runIngestCommand,
  init: runInit,
  mcp: runMcpCommand,
  service: runServiceCommand,
  sessions: runSessionsCommand,
  start: runStartCommand,
};

const COMMAND_HELP = Object.entries(COMMANDS)
  .map(([name, command]) => `  ${name.padEnd(20)} ${command.description}`)
  .join("\n");

export const HELP_TEXT = `saga — workspace memory for agentic work

usage: saga <command> [options]

commands:
${COMMAND_HELP}

options:
  -f, --format <fmt>   records|json|jsonl|ids
      --color <mode>   auto|always|never
      --ascii          disable color/icons
  -h, --help           show help
      --version        show version
`;

export function getCommand(name: string): CommandDefinition | undefined {
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name as CommandName] : undefined;
}

export function validateCommand(parsed: ParsedCommand): void {
  const name = parsed.command;
  if (name === undefined) return;

  const command = getCommand(name);
  if (command === undefined) {
    throw new UsageError(`unknown command: ${name}`);
  }

  const subcommands = command.subcommands;
  if (subcommands === undefined) return;

  const subcommand = parsed.args[0];
  if (subcommand === undefined) {
    throw new UsageError(`${name}: missing subcommand (expected: ${subcommands.join(" | ")})`);
  }
  if (!subcommands.includes(subcommand)) {
    throw new UsageError(
      `${name}: unknown subcommand ${subcommand} (expected: ${subcommands.join(" | ")})`,
    );
  }
}

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const options: GlobalOptions = { ...DEFAULT_OPTIONS };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (positionals.length > 0) {
      positionals.push(arg);
      continue;
    }

    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--version") {
      options.version = true;
      continue;
    }

    if (arg === "--ascii") {
      options.ascii = true;
      continue;
    }

    if (arg === "-f" || arg === "--format") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} expects a value`);
      if (!OUTPUT_FORMATS.has(value as OutputFormat)) {
        throw new UsageError(`unsupported format: ${value}`);
      }
      options.format = value as OutputFormat;
      index += 1;
      continue;
    }

    if (arg === "--color") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--color expects a value");
      if (!COLOR_MODES.has(value as ColorMode)) {
        throw new UsageError(`unsupported color mode: ${value}`);
      }
      options.color = value as ColorMode;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageError(`unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  return {
    args: positionals.slice(1),
    command: positionals[0],
    options,
  };
}

export async function run(
  argv: readonly string[],
  write: (text: string) => void,
  handlers: CommandHandlers = DEFAULT_HANDLERS,
): Promise<number> {
  let options: GlobalOptions | undefined;
  try {
    const parsed = parseArgs(argv);
    options = parsed.options;
    if (parsed.options.version) {
      write(`saga ${VERSION}`);
      return 0;
    }
    if (parsed.options.help || parsed.command === undefined) {
      write(HELP_TEXT.trimEnd());
      return 0;
    }

    validateCommand(parsed);
    const renderOptions = renderOptionsFromGlobals(parsed.options);
    if (parsed.command === "init") {
      write(await handlers.init(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === "doctor") {
      write(await handlers.doctor(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === "context") {
      write(await handlers.context(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === "harness") {
      write(await handlers.harness(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === "ingest") {
      write(await handlers.ingest(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === "mcp") {
      const output = await handlers.mcp(parsed.args, renderOptions, write);
      if (output !== undefined && output !== "") write(output);
      return 0;
    }
    if (parsed.command === "service") {
      write(await handlers.service(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === "sessions") {
      write(await handlers.sessions(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === "start") {
      return handlers.start(parsed.args, renderOptions, write);
    }

    write(`${parsed.command} is not implemented yet`);
    return 1;
  } catch (error) {
    if (error instanceof UsageError) {
      write(errorLine(error.message, renderOptionsFromGlobals(options ?? DEFAULT_OPTIONS)));
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    write(errorLine(message, renderOptionsFromGlobals(options ?? DEFAULT_OPTIONS)));
    return 1;
  }
}
