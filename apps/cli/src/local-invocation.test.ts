import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('local CLI invocation', () => {
  it('runs the documented pnpm package script', () => {
    const result = spawnSync('pnpm', ['--filter', '@saga/cli', 'saga', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain('usage: saga <command> [options]');
  });
});
