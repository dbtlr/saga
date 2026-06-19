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

export const HELP_TEXT = `saga — workspace memory for agentic work

usage: saga <command> [options]

commands:
  init                 bind this project to a Saga Workspace
  doctor               inspect local environment and Saga state
  start                launch local Saga service and control plane
  service <sub>        run or manage the Saga runtime service
  harness <sub>        install or inspect harness integrations
  mcp                  launch the stdio MCP adapter
  context              preview compiled Active Context
  ingest               manually ingest source data for debugging

options:
  -f, --format <fmt>   records|json|jsonl|ids
      --color <mode>   auto|always|never
      --ascii          disable color/icons
  -h, --help           show help
      --version        show version
`;

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const options: GlobalOptions = { ...DEFAULT_OPTIONS };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

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

export function run(argv: readonly string[], write: (text: string) => void): number {
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
    throw new UsageError(`unknown command: ${parsed.command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      write(errorLine(error.message, renderOptionsFromGlobals(options ?? DEFAULT_OPTIONS)));
      return 2;
    }
    throw error;
  }
}
