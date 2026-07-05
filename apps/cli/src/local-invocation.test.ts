import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const cliBin = join(dirname(fileURLToPath(import.meta.url)), '../bin/saga.js');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('local CLI invocation', () => {
  it('runs the CLI entry directly through node', () => {
    const result = spawnSync(process.execPath, [cliBin, '--help'], {
      encoding: 'utf8',
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain('usage: saga <command> [options]');
  });

  it('runs the documented bun package script', () => {
    const result = spawnSync('bun', ['run', '--filter', '@saga/cli', 'saga', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain('usage: saga <command> [options]');
  }, 30_000);
});
