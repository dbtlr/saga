import { runIngestCommand, runRecallCommand, runSessionsCommand } from '@saga/client-cli';
import type {
  ClientCommandContext,
  ColorMode,
  GlobalOptions as BaseGlobalOptions,
  OutputFormat,
} from '@saga/client-cli';

import { runDoctor } from './doctor.js';
import { runHarnessCommand } from './harness.js';
import { runInit } from './init.js';
import { runMcpCommand } from './mcp.js';
import { errorLine, renderOptionsFromGlobals } from './render.js';
import { runSelfUpdateCommand } from './self-update.js';
import { runServiceCommand } from './service.js';
import { runStartCommand } from './start.js';
import { VERSION } from './version.js';

export type { ColorMode, OutputFormat } from '@saga/client-cli';

// The dual-role CLI's global options extend the shared client options with the
// service-connection flags the migrated client commands (recall/sessions/ingest/
// doctor) and the MCP bridge resolve their service target from (SGA-249).
export type GlobalOptions = BaseGlobalOptions & {
  authToken: string | undefined;
  serviceUrl: string | undefined;
};

export type ParsedCommand = {
  args: string[];
  command: string | undefined;
  options: GlobalOptions;
};

export type CommandDefinition = {
  description: string;
  subcommands?: readonly string[];
};

export const COMMANDS = {
  init: { description: 'bind this project to a Saga Workspace' },
  doctor: { description: 'inspect local environment and Saga state' },
  start: { description: 'launch local Saga service and control plane' },
  service: {
    description: 'run or manage the Saga runtime service',
    subcommands: ['run', 'install', 'uninstall', 'start', 'stop', 'restart', 'status'],
  },
  harness: {
    description: 'install or inspect harness integrations',
    subcommands: ['install', 'uninstall', 'status'],
  },
  mcp: { description: 'bridge the stdio MCP transport to the Saga service' },
  ingest: {
    description: 'manually ingest source data for debugging',
    subcommands: ['claude-hook', 'codex-hook', 'recent'],
  },
  recall: {
    description: 'search and expand captured session memory',
    subcommands: ['search', 'show'],
  },
  sessions: {
    description: 'inspect captured session records',
    subcommands: ['recent', 'show'],
  },
  'self-update': { description: 'download, verify, and install the latest saga binary' },
} as const satisfies Record<string, CommandDefinition>;

export type CommandName = keyof typeof COMMANDS;

const OUTPUT_FORMATS = new Set<OutputFormat>(['records', 'json', 'jsonl', 'ids']);
const COLOR_MODES = new Set<ColorMode>(['auto', 'always', 'never']);

const isOutputFormat = (value: string): value is OutputFormat =>
  (OUTPUT_FORMATS as ReadonlySet<string>).has(value);
const isColorMode = (value: string): value is ColorMode =>
  (COLOR_MODES as ReadonlySet<string>).has(value);
const isCommandName = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

const DEFAULT_OPTIONS: GlobalOptions = {
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

export type CommandHandlers = {
  doctor: typeof runDoctor;
  harness: typeof runHarnessCommand;
  ingest: typeof runIngestCommand;
  init: typeof runInit;
  mcp: typeof runMcpCommand;
  recall: typeof runRecallCommand;
  selfUpdate: typeof runSelfUpdateCommand;
  service: typeof runServiceCommand;
  sessions: typeof runSessionsCommand;
  start: typeof runStartCommand;
};

export const DEFAULT_HANDLERS: CommandHandlers = {
  doctor: runDoctor,
  harness: runHarnessCommand,
  ingest: runIngestCommand,
  init: runInit,
  mcp: runMcpCommand,
  recall: runRecallCommand,
  selfUpdate: runSelfUpdateCommand,
  service: runServiceCommand,
  sessions: runSessionsCommand,
  start: runStartCommand,
};

const COMMAND_HELP = Object.entries(COMMANDS)
  .map(([name, command]) => `  ${name.padEnd(20)} ${command.description}`)
  .join('\n');

export const HELP_TEXT = `saga — workspace memory for agentic work

usage: saga <command> [options]

commands:
${COMMAND_HELP}

options:
  -f, --format <fmt>   records|json|jsonl|ids
      --color <mode>   auto|always|never
      --ascii          disable color/icons
      --service-url <url>  Saga service base URL (else SAGA_SERVICE_URL / config)
      --auth-token <tok>   bearer token for the service (else SAGA_AUTH_TOKEN / config)
  -h, --help           show help
      --version        show version

self-update options:
      --next           track the prerelease channel
      --tag <tag>      pin a specific release tag
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
  const options: GlobalOptions = { ...DEFAULT_OPTIONS };
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
    // The execution context for the migrated client commands: the service
    // connection resolved from the global flags (falling back to env/config inside
    // @saga/client-cli). Built once and shared by recall/sessions/ingest/doctor.
    const context: ClientCommandContext = {
      apiClient: {
        authToken: parsed.options.authToken,
        serviceUrl: parsed.options.serviceUrl,
      },
    };
    if (parsed.command === 'init') {
      write(await handlers.init(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === 'doctor') {
      write(await handlers.doctor(parsed.args, renderOptions, context));
      return 0;
    }
    if (parsed.command === 'harness') {
      write(await handlers.harness(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === 'ingest') {
      write(await handlers.ingest(parsed.args, renderOptions, context));
      return 0;
    }
    if (parsed.command === 'mcp') {
      const output = await handlers.mcp(parsed.args, renderOptions, write, {
        service: { authToken: parsed.options.authToken, serviceUrl: parsed.options.serviceUrl },
      });
      if (output !== undefined && output !== '') {
        write(output);
      }
      return 0;
    }
    if (parsed.command === 'recall') {
      write(await handlers.recall(parsed.args, renderOptions, context));
      return 0;
    }
    if (parsed.command === 'service') {
      write(await handlers.service(parsed.args, renderOptions));
      return 0;
    }
    if (parsed.command === 'sessions') {
      write(await handlers.sessions(parsed.args, renderOptions, context));
      return 0;
    }
    if (parsed.command === 'start') {
      return handlers.start(parsed.args, renderOptions, write);
    }
    if (parsed.command === 'self-update') {
      // Await so a rejection (refuse-from-source, download failure) is caught by
      // this function's try/catch and rendered as a clean error line rather than
      // escaping as an unhandled rejection.
      return await handlers.selfUpdate(parsed.args, renderOptions, write);
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
