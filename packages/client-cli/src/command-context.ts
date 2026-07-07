import type { SagaApiClient } from '@saga/api-client';

import { resolveApiClient } from './client.js';
import type { ResolveApiClientOptions } from './client.js';
import { resolveWorkspaceBinding } from './config.js';

// Shared execution context for the READ client commands (SGA-239 slice 2). The
// thin CLI builds it from the parsed global options (--service-url/--auth-token);
// tests inject a `client` and/or `workspaceId` directly so parity runs never need
// a live config file or on-disk binding.
export type ClientCommandContext = {
  // Options forwarded to resolveApiClient when no explicit client is injected
  // (service URL, auth token, env override).
  apiClient?: ResolveApiClientOptions | undefined;
  // Explicit client (DI seam). Wins over apiClient when present.
  client?: SagaApiClient | undefined;
  // Working directory used to resolve a workspace binding when no id is supplied
  // by flag or DI. Defaults to process.cwd().
  cwd?: string | undefined;
  // Explicit workspace id (DI seam). Overrides binding resolution but not flags.
  workspaceId?: string | undefined;
};

export function resolveClient(context: ClientCommandContext): SagaApiClient {
  return context.client ?? resolveApiClient(context.apiClient ?? {});
}

// Resolve the workspace the command operates on. Precedence (highest first):
// --workspace-id/--workspace flag -> injected context.workspaceId -> the config
// seam's binding for the checkout path. Throws a clear error when none resolves,
// mirroring the original commands' "workspace binding is missing" behavior.
export function resolveWorkspaceId(
  flags: Record<string, string>,
  context: ClientCommandContext,
): string {
  const fromFlag = flags['workspace-id'] ?? flags.workspace;
  if (fromFlag !== undefined) {
    return fromFlag;
  }
  if (context.workspaceId !== undefined) {
    return context.workspaceId;
  }
  const resolved = resolveWorkspaceBinding(context.cwd ?? process.cwd());
  if (resolved.source === 'client-config') {
    return resolved.binding.workspaceId;
  }
  if (resolved.source === 'binding-file') {
    return resolved.binding.workspace.id;
  }
  throw new Error(
    'no workspace resolved: pass --workspace-id, bind this checkout with `saga init`, or configure a workspace',
  );
}
