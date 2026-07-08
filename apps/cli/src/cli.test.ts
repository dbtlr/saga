import { describe, expect, it } from 'vitest';

import type { CommandHandlers } from './cli.js';
import { COMMANDS, HELP_TEXT, parseArgs, run, validateCommand } from './cli.js';
import { VERSION } from './version.js';

function commandHandlers(overrides: Partial<CommandHandlers> = {}): CommandHandlers {
  return {
    doctor: async () => 'doctor',
    harness: async () => 'harness',
    ingest: async () => 'ingest',
    init: async () => 'init',
    mcp: async () => 'mcp',
    recall: async () => 'recall',
    selfUpdate: async () => 0,
    service: async () => 'service',
    sessions: async () => 'sessions',
    start: async () => 0,
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('parses global flags and command arguments', () => {
    expect(
      parseArgs(['--format', 'json', '--color', 'never', '--ascii', 'doctor', 'preview']),
    ).toStrictEqual({
      args: ['preview'],
      command: 'doctor',
      options: {
        ascii: true,
        authToken: undefined,
        color: 'never',
        format: 'json',
        help: false,
        serviceUrl: undefined,
        version: false,
      },
    });
  });

  it('rejects unknown options', () => {
    expect(() => parseArgs(['--bad'])).toThrow('unknown option: --bad');
  });

  it('leaves command-specific options for command handlers', () => {
    expect(parseArgs(['sessions', 'recent', '--limit', '5'])).toMatchObject({
      args: ['recent', '--limit', '5'],
      command: 'sessions',
    });
  });

  it('parses global flags after command positionals', () => {
    expect(parseArgs(['sessions', 'recent', '--format', 'json'])).toStrictEqual({
      args: ['recent'],
      command: 'sessions',
      options: {
        ascii: false,
        authToken: undefined,
        color: 'auto',
        format: 'json',
        help: false,
        serviceUrl: undefined,
        version: false,
      },
    });
    expect(parseArgs(['doctor', '--format', 'json'])).toMatchObject({
      args: [],
      command: 'doctor',
      options: {
        format: 'json',
      },
    });
  });
});

describe('run', () => {
  it('help lists reserved command groups', () => {
    expect(HELP_TEXT).toContain('service');
    expect(HELP_TEXT).toContain('harness');
    expect(Object.keys(COMMANDS)).toStrictEqual([
      'init',
      'doctor',
      'start',
      'service',
      'harness',
      'mcp',
      'ingest',
      'recall',
      'sessions',
      'self-update',
    ]);
  });

  it('prints help without a command', async () => {
    const output: string[] = [];
    await expect(run([], (text) => output.push(text))).resolves.toBe(0);
    expect(output).toStrictEqual([HELP_TEXT.trimEnd()]);
  });

  it('prints version', async () => {
    const output: string[] = [];
    await expect(run(['--version'], (text) => output.push(text))).resolves.toBe(0);
    expect(output).toStrictEqual([`saga ${VERSION}`]);
  });

  it('reports unknown commands as usage errors', async () => {
    const output: string[] = [];
    await expect(run(['nope'], (text) => output.push(text))).resolves.toBe(2);
    expect(output).toStrictEqual(['✗ unknown command: nope']);
  });

  it('renders usage errors without glyphs in ascii mode', async () => {
    const output: string[] = [];
    await expect(run(['--ascii', 'nope'], (text) => output.push(text))).resolves.toBe(2);
    expect(output).toStrictEqual(['[err] unknown command: nope']);
  });

  it('dispatches start through the start handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      start: async (_args, _options, write) => {
        write('start launched');
        return 0;
      },
    });

    await expect(run(['start'], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toStrictEqual(['start launched']);
  });

  it('dispatches init through the init handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      init: async (args) => `init ${args.join(',')}`,
    });

    await expect(run(['init', 'custom'], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toStrictEqual(['init custom']);
  });

  it('dispatches doctor through the doctor handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      doctor: async () => 'doctor ok',
    });

    await expect(run(['doctor'], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toStrictEqual(['doctor ok']);
  });

  it('dispatches service through the service handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      service: async (args) => `service ${args.join(',')}`,
    });

    await expect(run(['service', 'status'], (text) => output.push(text), handlers)).resolves.toBe(
      0,
    );
    expect(output).toStrictEqual(['service status']);
  });

  it('dispatches harness through the harness handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      harness: async (args) => `harness ${args.join(',')}`,
    });

    await expect(
      run(['harness', 'install', 'codex'], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toStrictEqual(['harness install,codex']);
  });

  it('dispatches ingest through the ingest handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      ingest: async (args) => `ingest ${args.join(',')}`,
    });

    await expect(
      run(['ingest', 'codex-hook'], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toStrictEqual(['ingest codex-hook']);
  });

  it('dispatches sessions through the sessions handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      sessions: async (args) => `sessions ${args.join(',')}`,
    });

    await expect(
      run(['sessions', 'recent', '--limit', '5'], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toStrictEqual(['sessions recent,--limit,5']);
  });

  it('dispatches recall through the recall handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      recall: async (args) => `recall ${args.join(',')}`,
    });

    await expect(
      run(['recall', 'search', 'lexical', 'recall'], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(output).toStrictEqual(['recall search,lexical,recall']);
  });

  it('does not pass trailing global format flags to sessions handlers', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      sessions: async (args, options) =>
        JSON.stringify({
          args,
          format: options.format,
        }),
    });

    await expect(
      run(['sessions', 'recent', '--format', 'json'], (text) => output.push(text), handlers),
    ).resolves.toBe(0);
    expect(JSON.parse(output[0] ?? '{}')).toStrictEqual({
      args: ['recent'],
      format: 'json',
    });
  });

  it('does not pass trailing global format flags to recall handlers', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      recall: async (args, options) =>
        JSON.stringify({
          args,
          format: options.format,
        }),
    });

    await expect(
      run(
        ['recall', 'search', 'needle', '--format', 'json'],
        (text) => output.push(text),
        handlers,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(output[0] ?? '{}')).toStrictEqual({
      args: ['search', 'needle'],
      format: 'json',
    });
  });

  it('rejects the removed context command', async () => {
    const output: string[] = [];

    await expect(run(['context'], (text) => output.push(text))).resolves.toBe(2);
    expect(output).toStrictEqual(['✗ unknown command: context']);
  });

  it('rejects the removed ingest claims subcommand', async () => {
    const output: string[] = [];

    await expect(run(['ingest', 'claims'], (text) => output.push(text))).resolves.toBe(2);
    expect(output).toStrictEqual([
      '✗ ingest: unknown subcommand claims (expected: claude-hook | codex-hook | recent)',
    ]);
  });

  it('dispatches mcp through the streaming mcp handler', async () => {
    const output: string[] = [];
    const handlers = commandHandlers({
      mcp: async (_args, _options, write) => {
        write('mcp response');
        return undefined;
      },
    });

    await expect(run(['mcp'], (text) => output.push(text), handlers)).resolves.toBe(0);
    expect(output).toStrictEqual(['mcp response']);
  });

  it('implemented commands can render structured output', async () => {
    const output: string[] = [];

    await expect(
      run(['--format', 'json', 'service', 'status'], (text) => output.push(text)),
    ).resolves.toBe(0);
    expect(() => JSON.parse(output[0] ?? '')).not.toThrow();
  });
});

describe('validateCommand', () => {
  it('requires reserved service subcommands', () => {
    expect(() =>
      validateCommand({
        args: [],
        command: 'service',
        options: {
          ascii: false,
          authToken: undefined,
          color: 'auto',
          format: 'records',
          help: false,
          serviceUrl: undefined,
          version: false,
        },
      }),
    ).toThrow('service: missing subcommand');
  });

  it('accepts reserved harness subcommands', () => {
    expect(() =>
      validateCommand({
        args: ['install', 'codex'],
        command: 'harness',
        options: {
          ascii: false,
          authToken: undefined,
          color: 'auto',
          format: 'records',
          help: false,
          serviceUrl: undefined,
          version: false,
        },
      }),
    ).not.toThrow();
  });
});
