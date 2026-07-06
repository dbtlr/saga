import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bindingPathFor, BINDING_FILE_NAME, readBindingFile } from './binding.js';
import type { WorkspaceBindingFile } from './binding.js';

const representativeBinding: WorkspaceBindingFile = {
  harnesses: {
    claude: {
      hookCommand: 'saga ingest claude-hook',
      hookTrust: 'requires-review',
      hooksPath: '/checkout/.claude/settings.json',
      installedAt: '2026-06-19T20:00:00.000Z',
      sourceBindingId: 'source-binding-id',
      sourceUri: 'claude://local',
      target: 'claude',
    },
  },
  host: {
    generatedAt: '2026-06-19T20:00:00.000Z',
    id: 'host-id',
    label: 'laptop.local',
  },
  project: { gitRemote: 'git@example.com:acme/app.git', root: '/checkout' },
  schemaVersion: 1,
  service: { databaseUrl: 'installation-config' },
  sourceBinding: { id: 'source-binding-id' },
  workspace: { handle: 'app', id: 'workspace-id' },
};

describe('bindingPathFor', () => {
  it('joins the project root with the binding file name', () => {
    expect(bindingPathFor('/checkout')).toBe(join('/checkout', BINDING_FILE_NAME));
  });
});

describe('readBindingFile', () => {
  it('returns undefined when no binding file is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saga-binding-'));
    expect(readBindingFile(dir)).toBeUndefined();
  });

  it('parses a representative .saga.local.json identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saga-binding-'));
    writeFileSync(
      join(dir, BINDING_FILE_NAME),
      `${JSON.stringify(representativeBinding, null, 2)}\n`,
    );
    expect(readBindingFile(dir)).toStrictEqual(representativeBinding);
  });
});
