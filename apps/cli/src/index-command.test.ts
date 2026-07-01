import { describe, expect, it } from 'vitest';

import { runIndexCommand } from './index-command.js';

const renderOptions = {
  ascii: true,
  color: 'never',
  format: 'records',
  isTty: false,
} as const;

// These inputs fail during argument parsing, before the command loads a bound
// project or opens a database, so they need no fixture.
describe('index command argument parsing', () => {
  it('rejects an unknown option', async () => {
    await expect(runIndexCommand(['--nope'], renderOptions)).rejects.toThrow(
      'unknown index option: --nope',
    );
  });

  it('rejects an unexpected positional', async () => {
    await expect(runIndexCommand(['extra'], renderOptions)).rejects.toThrow(
      'index received unexpected argument: extra',
    );
  });

  it('rejects a valued flag with no value', async () => {
    await expect(runIndexCommand(['--limit'], renderOptions)).rejects.toThrow(
      '--limit expects a value',
    );
  });
});
