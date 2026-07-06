import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseUrlSource } from '@saga/runtime';

export const BINDING_FILE_NAME = '.saga.local.json';

type WorkspaceHarnessTarget = 'codex' | 'claude';
type WorkspaceHarnessSourceUri =
  | 'claude://local'
  | 'codex://local'
  | `claude://host/${string}`
  | `codex://host/${string}`;

type WorkspaceHarnessBinding = {
  hookCommand: string;
  hookTrust: 'requires-review';
  hooksPath: string;
  installedAt: string;
  sourceBindingId: string;
  sourceUri: WorkspaceHarnessSourceUri;
  target: WorkspaceHarnessTarget;
};

export type WorkspaceBindingFile = {
  harnesses?: Partial<Record<WorkspaceHarnessTarget, WorkspaceHarnessBinding>>;
  host?: {
    generatedAt: string;
    id: string;
    label: string;
  };
  project: {
    gitRemote: string | undefined;
    root: string;
  };
  schemaVersion: 1;
  service: {
    // The name-free provenance of where the workspace's database URL resolved
    // from (config.databaseUrlSource), not the variable name. Pre-release local
    // binding (ADR-0020), so recording the enum here is a free schema change.
    databaseUrl: DatabaseUrlSource;
  };
  sourceBinding: {
    id: string;
  };
  workspace: {
    handle: string;
    id: string;
  };
};

export function bindingPathFor(projectRoot: string): string {
  return join(projectRoot, BINDING_FILE_NAME);
}

export function readBindingFile(projectRoot: string): WorkspaceBindingFile | undefined {
  const bindingPath = bindingPathFor(projectRoot);
  if (!existsSync(bindingPath)) {
    return undefined;
  }
  // Boundary: the binding file is written and owned by saga (writeBindingFile);
  // JSON.parse yields `any`, and callers defensively re-check fields (host,
  // harnesses, sourceBindingId) before use, so trusting the on-disk shape here is
  // the correct seam.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- trusted on-disk binding shape; callers re-validate fields
  return JSON.parse(readFileSync(bindingPath, 'utf8')) as WorkspaceBindingFile;
}
