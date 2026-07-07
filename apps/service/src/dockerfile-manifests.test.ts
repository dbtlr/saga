import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const dockerfile = readFileSync(join(repoRoot, 'apps/service/Dockerfile'), 'utf8');

function workspaceMemberDirs(): string[] {
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    workspaces: string[];
  };
  const dirs: string[] = [];
  for (const pattern of rootManifest.workspaces) {
    // Patterns are the simple `apps/*` / `packages/*` form; anything fancier
    // should fail loudly here so this guard gets extended with it.
    const parent = /^([a-z-]+)\/\*$/.exec(pattern)?.[1];
    if (parent === undefined) {
      throw new Error(`unsupported workspace pattern: ${pattern}`);
    }
    for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(repoRoot, parent, entry.name, 'package.json'))) {
        dirs.push(`${parent}/${entry.name}`);
      }
    }
  }
  return dirs;
}

describe('service Dockerfile workspace manifests', () => {
  // bun install --frozen-lockfile requires every workspace member's
  // package.json in the image; a member missing from the COPY list only
  // surfaces when the docker smoke runs. Fail at unit-test time instead.
  it('copies every workspace member package.json before bun install', () => {
    const missing = workspaceMemberDirs().filter(
      (dir) => !dockerfile.includes(`COPY ${dir}/package.json ./${dir}/`),
    );
    expect(missing).toStrictEqual([]);
  });
});
