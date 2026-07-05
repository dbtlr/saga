import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { isRecord, optionalString, readInstallationConfig } from './internal/credential-io.js';

export type RemoteEmbeddingPolicyState = 'enabled' | 'disabled';
// "default" covers the fail-closed cases: no config, missing key, or unreadable/malformed
// config. A future workspace override layer adds "workspace-config" without touching callers.
export type EmbeddingPolicySource = 'installation-config' | 'default';

export type EmbeddingPolicyResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readFile?: (path: string) => string;
};

export type EmbeddingPolicy = {
  detail: string;
  remoteEmbeddings: RemoteEmbeddingPolicyState;
  source: EmbeddingPolicySource;
};

export type InstallationConfigLocation = {
  displayPath: string;
  path: string;
};

export function installationConfigLocation(
  options: EmbeddingPolicyResolutionOptions = {},
): InstallationConfigLocation {
  const env = options.env ?? process.env;
  const sagaHome = optionalString(env.SAGA_HOME);
  if (sagaHome !== undefined) {
    return {
      displayPath: 'SAGA_HOME/config.json',
      path: resolve(sagaHome, 'config.json'),
    };
  }

  const home = options.homeDir ?? homedir();
  return {
    displayPath: '~/.saga/config.json',
    path: resolve(home, '.saga', 'config.json'),
  };
}

export function resolveEmbeddingPolicy(
  options: EmbeddingPolicyResolutionOptions = {},
): EmbeddingPolicy {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const location = installationConfigLocation(options);

  const read = readInstallationConfig(location, readFile);
  if (read.status === 'missing') {
    return disabledByDefault(
      `no installation config at ${location.displayPath}; remote embeddings disabled by default`,
    );
  }
  if (read.status === 'unreadable' || read.status === 'malformed') {
    return disabledByDefault(`${read.message}; remote embeddings disabled`);
  }

  const remote = readRemoteEmbeddingsState(read.value);
  if (remote === 'enabled') {
    return {
      detail: `remote embeddings enabled by installation standard in ${location.displayPath}`,
      remoteEmbeddings: 'enabled',
      source: 'installation-config',
    };
  }
  if (remote === 'disabled') {
    return {
      detail: `remote embeddings disabled by installation standard in ${location.displayPath}`,
      remoteEmbeddings: 'disabled',
      source: 'installation-config',
    };
  }

  return disabledByDefault(
    `${location.displayPath} does not set embeddings.remote; remote embeddings disabled by default`,
  );
}

function disabledByDefault(detail: string): EmbeddingPolicy {
  return {
    detail,
    remoteEmbeddings: 'disabled',
    source: 'default',
  };
}

function readRemoteEmbeddingsState(value: unknown): RemoteEmbeddingPolicyState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const embeddings = value.embeddings;
  if (!isRecord(embeddings)) {
    return undefined;
  }
  const remote = embeddings.remote;
  if (remote === 'enabled' || remote === 'disabled') {
    return remote;
  }
  return undefined;
}
