import type { ColorMode, GlobalOptions, OutputFormat } from './options.js';
import { errorLine, renderOptionsFromGlobals } from './render.js';
import { VERSION } from './version.js';

// Standalone client-cli entry point (SGA-239 slice 1: mechanical foundation).
// Mirrors the shape of apps/cli/src/cli.ts (parseArgs/COMMANDS/run), but the
// command table starts empty — commands are registered in later slices as the
// client surface grows.

export type ClientGlobalOptions = GlobalOptions & {
  authToken: string | undefined;
  serviceUrl: string | undefined;
};

export type ParsedCommand = {
  args: string[];
  command: string | undefined;
  options: ClientGlobalOptions;
};

export type CommandDefinition = {
  description: string;
  subcommands?: readonly string[];
};

// Empty in this slice: later slices add entries as commands are ported over
// from apps/cli onto the standalone client surface.
export const COMMANDS = {} as const satisfies Record<string, CommandDefinition>;

export type CommandName = keyof typeof COMMANDS;

const OUTPUT_FORMATS = new Set<OutputFormat>(['records', 'json', 'jsonl', 'ids']);
const COLOR_MODES = new Set<ColorMode>(['auto', 'always', 'never']);

const isOutputFormat = (value: string): value is OutputFormat =>
  (OUTPUT_FORMATS as ReadonlySet<string>).has(value);
const isColorMode = (value: string): value is ColorMode =>
  (COLOR_MODES as ReadonlySet<string>).has(value);
const isCommandName = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

const DEFAULT_OPTIONS: ClientGlobalOptions = {
  ascii: false,
  authToken: undefined,
  color: 'auto',
  format: 'records',
  help: false,
  serviceUrl: undefined,
  version: false,
};

export class UsageError extends Error {
  readonly code = 'usage';

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

// Empty in this slice, matching COMMANDS; later slices widen both together.
export type CommandHandlers = Record<CommandName, never>;

export const DEFAULT_HANDLERS: CommandHandlers = {};

const COMMAND_HELP = Object.entries(COMMANDS as Record<string, CommandDefinition>)
  .map(([name, command]) => `  ${name.padEnd(20)} ${command.description}`)
  .join('\n');

export const HELP_TEXT = `saga-client — standalone Saga client

usage: saga-client <command> [options]

commands:
${COMMAND_HELP === '' ? '  (no commands registered yet)' : COMMAND_HELP}

options:
  -f, --format <fmt>      records|json|jsonl|ids
      --color <mode>      auto|always|never
      --ascii              disable color/icons
      --service-url <url>  saga service base URL (env: SAGA_SERVICE_URL)
      --auth-token <token> saga service auth token (env: SAGA_AUTH_TOKEN)
  -h, --help               show help
      --version            show version
`;

export function getCommand(name: string): CommandDefinition | undefined {
  return isCommandName(name) ? COMMANDS[name] : undefined;
}

export function validateCommand(parsed: ParsedCommand): void {
  const name = parsed.command;
  if (name === undefined) {
    return;
  }

  const command = getCommand(name);
  if (command === undefined) {
    throw new UsageError(`unknown command: ${name}`);
  }

  const subcommands = command.subcommands;
  if (subcommands === undefined) {
    return;
  }

  const subcommand = parsed.args[0];
  if (subcommand === undefined) {
    throw new UsageError(`${name}: missing subcommand (expected: ${subcommands.join(' | ')})`);
  }
  if (!subcommands.includes(subcommand)) {
    throw new UsageError(
      `${name}: unknown subcommand ${subcommand} (expected: ${subcommands.join(' | ')})`,
    );
  }
}

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const options: ClientGlobalOptions = { ...DEFAULT_OPTIONS };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }

    if (arg === '--version') {
      options.version = true;
      continue;
    }

    if (arg === '--ascii') {
      options.ascii = true;
      continue;
    }

    if (arg === '-f' || arg === '--format') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new UsageError(`${arg} expects a value`);
      }
      if (!isOutputFormat(value)) {
        throw new UsageError(`unsupported format: ${value}`);
      }
      options.format = value;
      index += 1;
      continue;
    }

    if (arg === '--color') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new UsageError('--color expects a value');
      }
      if (!isColorMode(value)) {
        throw new UsageError(`unsupported color mode: ${value}`);
      }
      options.color = value;
      index += 1;
      continue;
    }

    if (arg === '--service-url') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new UsageError('--service-url expects a value');
      }
      options.serviceUrl = value;
      index += 1;
      continue;
    }

    if (arg === '--auth-token') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new UsageError('--auth-token expects a value');
      }
      options.authToken = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('-') && positionals.length === 0) {
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
  let options: ClientGlobalOptions | undefined;
  try {
    const parsed = parseArgs(argv);
    options = parsed.options;
    if (parsed.options.version) {
      write(`saga-client ${VERSION}`);
      return 0;
    }
    if (parsed.options.help || parsed.command === undefined) {
      write(HELP_TEXT.trimEnd());
      return 0;
    }

    validateCommand(parsed);

    // No commands are registered yet (this slice is plumbing-only); every
    // valid, known command name still has nothing to dispatch to. A future
    // slice widens COMMANDS/CommandHandlers together and adds the dispatch
    // arms here, mirroring apps/cli/src/cli.ts's per-command `if` chain.
    void handlers;
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
