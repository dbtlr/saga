import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findProjectRoot } from './project-root.js';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'saga-project-root-')));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('findProjectRoot', () => {
  it('resolves the git toplevel from a nested directory', () => {
    const repoRoot = makeTempDir();
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
    const nested = join(repoRoot, 'apps', 'service');
    mkdirSync(nested, { recursive: true });

    expect(findProjectRoot(nested)).toBe(repoRoot);
  });

  it('falls back to the resolved cwd outside a git repository', () => {
    const plainDir = makeTempDir();

    expect(findProjectRoot(plainDir)).toBe(resolve(plainDir));
  });
});
