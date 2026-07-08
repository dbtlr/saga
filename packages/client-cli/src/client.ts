import { SagaApiClient } from '@saga/api-client';

import { loadClientConfig } from './config.js';
import type { ClientConfig, ClientConfigResolutionOptions } from './config.js';

// Resolves the SagaApiClient the standalone client-cli talks to the service
// through. Precedence (highest first): explicit args (for tests/overrides) ->
// env vars -> the loaded client config (~/.saga/config.json). authToken is
// optional at every level (an unauthenticated service is a valid setup);
// serviceUrl is required from somewhere or resolution throws a clear error
// rather than constructing a client that can never reach a service.
export type ResolveApiClientOptions = ClientConfigResolutionOptions & {
  authToken?: string | undefined;
  env?: NodeJS.ProcessEnv;
  serviceUrl?: string | undefined;
};

// The service base URL the client resolves, using the same precedence as
// resolveApiClient. Exposed so the doctor can name the target in its service
// reachability check (and report a clear "not configured" state) without
// reconstructing the resolution rules. Throws the identical error as
// resolveApiClient when no URL resolves.
export function resolveServiceUrl(options: ResolveApiClientOptions = {}): string {
  return resolveServiceUrlFromConfig(loadClientConfig(options), options);
}

// Resolve the URL from an already-loaded config, so callers that also need other
// config fields load the file exactly once.
function resolveServiceUrlFromConfig(
  config: ClientConfig,
  options: ResolveApiClientOptions,
): string {
  const env = options.env ?? process.env;
  const serviceUrl = options.serviceUrl ?? env.SAGA_SERVICE_URL ?? config.service?.url;
  if (serviceUrl === undefined || serviceUrl === '') {
    throw new Error(
      'no saga service URL configured: pass --service-url, set SAGA_SERVICE_URL, or run `saga init`',
    );
  }
  return serviceUrl;
}

// The resolved service connection — base URL plus optional auth token — using the
// same precedence as resolveApiClient. Exposed so callers that speak to the service
// over a transport SagaApiClient does not model (e.g. the CLI's stdio→HTTP MCP
// bridge POSTing to /mcp) can reach it without reconstructing the resolution rules.
export type ServiceConnection = {
  authToken: string | undefined;
  baseUrl: string;
};

export function resolveServiceConnection(options: ResolveApiClientOptions = {}): ServiceConnection {
  const env = options.env ?? process.env;
  const config = loadClientConfig(options);
  return {
    authToken: options.authToken ?? env.SAGA_AUTH_TOKEN ?? config.authToken,
    baseUrl: resolveServiceUrlFromConfig(config, options),
  };
}

export function resolveApiClient(options: ResolveApiClientOptions = {}): SagaApiClient {
  const { authToken, baseUrl } = resolveServiceConnection(options);
  return new SagaApiClient({ authToken, baseUrl });
}
