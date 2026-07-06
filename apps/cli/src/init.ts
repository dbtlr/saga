import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { bindingPathFor } from '@saga/client-cli';
import type { WorkspaceBindingFile } from '@saga/client-cli';
import { makeDatabase, registerWorkspace, runMigrationsSafely } from '@saga/db';
import type { RegisterWorkspaceResult } from '@saga/db';
import {
  DATABASE_URL_ENV,
  findProjectRoot,
  installationConfigLocation,
  loadRuntimeConfig,
} from '@saga/runtime';
import type { LoadRuntimeConfigOptions } from '@saga/runtime';
import { Effect } from 'effect';

import { formatCommandOutput } from './output.js';
import { recordBlock } from './render.js';
import type { RenderOptions } from './render.js';

export { findProjectRoot } from '@saga/runtime';
// The .saga.local.json read path now lives in @saga/client-cli (the client tier
// owns binding reads); re-exported here so existing importers of ./init.js are
// unaffected. Write logic (writeBindingFile, host identity) stays below.
export { BINDING_FILE_NAME, bindingPathFor, readBindingFile } from '@saga/client-cli';
export type { WorkspaceBindingFile } from '@saga/client-cli';

export type InitResult = {
  bindingPath: string;
  projectRoot: string;
  registration: RegisterWorkspaceResult;
};

export type WorkspaceBindingFileWithHost = WorkspaceBindingFile & {
  host: NonNullable<WorkspaceBindingFile['host']>;
};

export async function runInit(args: readonly string[], options: RenderOptions): Promise<string> {
  const result = await initProject({ handle: args[0] });
  const records = recordBlock(
    'Workspace bound',
    [
      { label: 'workspace', value: result.registration.workspace.handle },
      { label: 'workspace id', value: result.registration.workspace.id },
      { label: 'source', value: result.registration.sourceBinding.sourceUri },
      { label: 'binding', value: result.bindingPath },
    ],
    options,
  );
  return formatCommandOutput(
    {
      id: result.registration.workspace.id,
      records,
      value: {
        bindingPath: result.bindingPath,
        projectRoot: result.projectRoot,
        sourceBinding: result.registration.sourceBinding,
        workspace: result.registration.workspace,
      },
    },
    options.format,
  );
}

export async function initProject(input: {
  cwd?: string;
  handle?: string | undefined;
  runtimeConfig?: Omit<LoadRuntimeConfigOptions, 'cwd'>;
}): Promise<InitResult> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const gitRemote = readGitRemote(projectRoot);
  const handle = normalizeHandle(input.handle ?? basename(projectRoot));
  const sourceUri = pathToFileURL(projectRoot).href;

  const runtimeConfig = input.runtimeConfig ?? {};
  const config = await Effect.runPromise(loadRuntimeConfig({ ...runtimeConfig, cwd: projectRoot }));
  if (config.databaseUrl === undefined) {
    const installationConfig = installationConfigLocation({
      env: runtimeConfig.env ?? process.env,
      ...(runtimeConfig.homeDir === undefined ? {} : { homeDir: runtimeConfig.homeDir }),
    });
    throw new Error(
      `${DATABASE_URL_ENV} is not configured; set it in the environment, in ${join(projectRoot, '.env.local')}, or as database.url in ${installationConfig.displayPath}`,
    );
  }
  const service = await Effect.runPromise(makeDatabase(config));

  try {
    await Effect.runPromise(runMigrationsSafely(service));
    const registration = await Effect.runPromise(
      registerWorkspace(service, {
        displayName: basename(projectRoot),
        handle,
        source: {
          config: {
            gitRemote,
            path: projectRoot,
          },
          displayName: basename(projectRoot),
          type: 'git',
          uri: sourceUri,
        },
      }),
    );
    const bindingPath = writeBindingFile(projectRoot, {
      host: createLocalHostBinding(),
      project: {
        gitRemote,
        root: projectRoot,
      },
      schemaVersion: 1,
      service: {
        databaseUrl: config.databaseUrlSource,
      },
      sourceBinding: {
        id: registration.sourceBinding.id,
      },
      workspace: {
        handle: registration.workspace.handle,
        id: registration.workspace.id,
      },
    });

    return {
      bindingPath,
      projectRoot,
      registration,
    };
  } finally {
    await Effect.runPromise(service.close());
  }
}

export function readGitRemote(projectRoot: string): string | undefined {
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return remote === '' ? undefined : remote;
  } catch {
    return undefined;
  }
}

export function normalizeHandle(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return normalized === '' ? 'workspace' : normalized;
}

export function createLocalHostBinding(): WorkspaceBindingFileWithHost['host'] {
  return {
    generatedAt: new Date().toISOString(),
    id: randomUUID(),
    label: hostname(),
  };
}

export function ensureLocalHostBinding(
  binding: WorkspaceBindingFile,
): WorkspaceBindingFileWithHost {
  if (
    binding.host !== undefined &&
    typeof binding.host.id === 'string' &&
    binding.host.id.trim() !== ''
  ) {
    return { ...binding, host: binding.host };
  }
  return {
    ...binding,
    host: createLocalHostBinding(),
  };
}

export function writeBindingFile(projectRoot: string, binding: WorkspaceBindingFile): string {
  mkdirSync(projectRoot, { recursive: true });
  const bindingPath = bindingPathFor(projectRoot);
  writeFileSync(bindingPath, `${JSON.stringify(ensureLocalHostBinding(binding), null, 2)}\n`);
  return bindingPath;
}
