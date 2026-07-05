import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const cliBin = join(dirname(fileURLToPath(import.meta.url)), '../bin/saga.js');

describe('local CLI invocation', () => {
  it('runs the CLI entry directly through node', () => {
    const result = spawnSync(process.execPath, [cliBin, '--help'], {
      encoding: 'utf8',
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain('usage: saga <command> [options]');
  });
});
