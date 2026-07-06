import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { installationConfigLocation } from '@saga/runtime';

import { readBindingFile } from './binding.js';
import type { WorkspaceBindingFile } from './binding.js';

// Client-tier view of ~/.saga/config.json (SAGA_HOME-aware via
// installationConfigLocation). These keys are new: nothing writes them yet
// ("written once, no tooling" arrives in a later phase), so every reader below is
// tolerant — a missing file, missing key, or wrong-typed value resolves to
// undefined/empty and never throws. The runtime's {database:{url}} reader
// (@saga/runtime) is a separate seam over the same file; the two do not interfere,
// so pre-existing config files keep working unchanged.

// A single workspace binding recorded in the client config's `workspaces` map
// (ADR-0050): checkout path -> { workspaceId, repo?: { remote? } }. The schema
// leaves room for the later signal-hierarchy fields (git-config marker, etc.)
// without committing to them now.
export type ClientWorkspaceBinding = {
  repo?: { remote?: string };
  workspaceId: string;
};

export type ClientConfig = {
  authToken?: string;
  hostname?: string;
  service?: { url?: string };
  // Spool directory for outbound client events. Absent means the default,
  // resolved by clientSpoolDir() to <SAGA_HOME|~/.saga>/spool.
  spool?: { dir?: string };
  workspaces: Record<string, ClientWorkspaceBinding>;
};

export type ClientConfigResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readFile?: (path: string) => string;
};

// Which source answered a binding lookup, so callers can branch on provenance
// (ADR-0050: the client config's `workspaces` map is authoritative; the per-repo
// .saga.local.json is the transition-era fallback readers still honor).
export type ResolvedWorkspaceBinding =
  | { binding: ClientWorkspaceBinding; source: 'client-config' }
  | { binding: WorkspaceBindingFile; source: 'binding-file' }
  | { source: 'none' };

export function loadClientConfig(options: ClientConfigResolutionOptions = {}): ClientConfig {
  const location = installationConfigLocation(options);
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  let raw: string;
  try {
    raw = readFile(location.path);
  } catch {
    // Missing or unreadable config: these keys are new and optional, so resolve
    // to empty rather than surfacing an error.
    return { workspaces: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { workspaces: {} };
  }
  if (!isRecord(parsed)) {
    return { workspaces: {} };
  }

  const config: ClientConfig = { workspaces: readWorkspaces(parsed.workspaces) };
  const service = readService(parsed.service);
  if (service !== undefined) {
    config.service = service;
  }
  const authToken = optionalString(parsed.authToken);
  if (authToken !== undefined) {
    config.authToken = authToken;
  }
  const hostname = optionalString(parsed.hostname);
  if (hostname !== undefined) {
    config.hostname = hostname;
  }
  const spool = readSpool(parsed.spool);
  if (spool !== undefined) {
    config.spool = spool;
  }
  return config;
}

// The effective spool directory: the configured value if set, else the default
// under <SAGA_HOME|~/.saga>/spool. installationConfigLocation resolves the base so
// SAGA_HOME is honored without duplicating that logic.
export function clientSpoolDir(
  config: ClientConfig,
  options: ClientConfigResolutionOptions = {},
): string {
  const configured = optionalString(config.spool?.dir);
  if (configured !== undefined) {
    return configured;
  }
  const location = installationConfigLocation(options);
  return resolve(location.path, '..', 'spool');
}

// Resolve the binding for a checkout path. Phase A: an exact-path hit in the
// client config's `workspaces` map wins; on a miss, fall back to reading the
// per-repo .saga.local.json (the moved binding reader). Full signal-hierarchy
// resolution is a later phase.
export function resolveWorkspaceBinding(
  checkoutPath: string,
  options: ClientConfigResolutionOptions & { config?: ClientConfig } = {},
): ResolvedWorkspaceBinding {
  const config = options.config ?? loadClientConfig(options);
  const hit = config.workspaces[resolve(checkoutPath)];
  if (hit !== undefined) {
    return { binding: hit, source: 'client-config' };
  }
  // readBindingFile throws on a malformed .saga.local.json (the established
  // semantic for apps/cli callers); the client resolver treats a malformed file
  // as a miss rather than propagating, so a broken per-repo file never crashes
  // a lookup.
  let binding: WorkspaceBindingFile | undefined;
  try {
    binding = readBindingFile(checkoutPath);
  } catch {
    return { source: 'none' };
  }
  if (binding !== undefined) {
    return { binding, source: 'binding-file' };
  }
  return { source: 'none' };
}

function readService(value: unknown): { url?: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const url = optionalString(value.url);
  return url === undefined ? undefined : { url };
}

function readSpool(value: unknown): { dir?: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const dir = optionalString(value.dir);
  return dir === undefined ? undefined : { dir };
}

function readWorkspaces(value: unknown): Record<string, ClientWorkspaceBinding> {
  if (!isRecord(value)) {
    return {};
  }
  const workspaces: Record<string, ClientWorkspaceBinding> = {};
  for (const [path, entry] of Object.entries(value)) {
    const binding = readWorkspaceBinding(entry);
    if (binding !== undefined) {
      // Normalize keys with path.resolve so lookups (also resolve()-normalized in
      // resolveWorkspaceBinding) are symmetric — a trailing slash or `.`/`..`
      // segment on either side must not cause a miss.
      workspaces[resolve(path)] = binding;
    }
  }
  return workspaces;
}

function readWorkspaceBinding(value: unknown): ClientWorkspaceBinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const workspaceId = optionalString(value.workspaceId);
  if (workspaceId === undefined) {
    return undefined;
  }
  const binding: ClientWorkspaceBinding = { workspaceId };
  const repo = readRepo(value.repo);
  if (repo !== undefined) {
    binding.repo = repo;
  }
  return binding;
}

function readRepo(value: unknown): { remote?: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const remote = optionalString(value.remote);
  return remote === undefined ? undefined : { remote };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
