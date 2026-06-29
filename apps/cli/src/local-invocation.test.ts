import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('local CLI invocation', () => {
  test('runs the documented pnpm package script', () => {
    const result = spawnSync('pnpm', ['--filter', '@saga/cli', 'saga', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('usage: saga <command> [options]');
  });
});
