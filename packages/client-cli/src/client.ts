import { SagaApiClient } from '@saga/api-client';

import { loadClientConfig } from './config.js';
import type { ClientConfigResolutionOptions } from './config.js';

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

export function resolveApiClient(options: ResolveApiClientOptions = {}): SagaApiClient {
  const env = options.env ?? process.env;
  const config = loadClientConfig(options);

  const serviceUrl = options.serviceUrl ?? env.SAGA_SERVICE_URL ?? config.service?.url;
  if (serviceUrl === undefined || serviceUrl === '') {
    throw new Error(
      'no saga service URL configured: pass --service-url, set SAGA_SERVICE_URL, or run `saga init`',
    );
  }

  const authToken = options.authToken ?? env.SAGA_AUTH_TOKEN ?? config.authToken;

  return new SagaApiClient({ authToken, baseUrl: serviceUrl });
}
