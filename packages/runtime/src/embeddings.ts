import { resolveCodexAuth } from './codex-auth.js';
import type { CodexAuthResolutionOptions, CodexAuthStatus } from './codex-auth.js';
import { resolveEmbeddingPolicy } from './embedding-policy.js';
import type { EmbeddingPolicy, EmbeddingPolicyResolutionOptions } from './embedding-policy.js';

export type EmbeddingProviderId = 'openai';
export type EmbeddingAvailabilityState = 'available' | 'skipped';
export type LexicalFallbackState = 'active' | 'standby';
// The effective recall capability after composing installation policy with credentials.
export type EmbeddingEffectiveMode = 'vector-aware' | 'lexical-only-by-policy' | 'lexical-fallback';

export const DISABLED_BY_POLICY_REASON = 'disabled-by-policy';

export type EmbeddingProviderBoundary = {
  dimensions: number;
  id: EmbeddingProviderId;
  model: string;
};

export type EmbeddingCredentialStatus = {
  authMode: CodexAuthStatus['mode'];
  detail: string;
  source: 'codex-auth';
};

export type EmbeddingWorkflowAvailability = {
  credential: EmbeddingCredentialStatus;
  detail: string;
  guidance: string;
  reason: string;
  state: EmbeddingAvailabilityState;
};

export type EmbeddingWorkflowBoundary = {
  availability: EmbeddingWorkflowAvailability;
  lexicalFallback: {
    detail: string;
    state: LexicalFallbackState;
  };
  mode: EmbeddingEffectiveMode;
  policy: EmbeddingPolicy;
  provider: EmbeddingProviderBoundary;
};

export const DEFAULT_OPENAI_EMBEDDING_PROVIDER: EmbeddingProviderBoundary = {
  dimensions: 1536,
  id: 'openai',
  model: 'text-embedding-3-small',
};

export function inspectEmbeddingWorkflow(
  authOptions: CodexAuthResolutionOptions = {},
  policyOptions: EmbeddingPolicyResolutionOptions = {},
): EmbeddingWorkflowBoundary {
  return composeEmbeddingWorkflow({
    auth: resolveCodexAuth(authOptions),
    policy: resolveEmbeddingPolicy(policyOptions),
  });
}

export function composeEmbeddingWorkflow(input: {
  auth: CodexAuthStatus;
  policy: EmbeddingPolicy;
}): EmbeddingWorkflowBoundary {
  const { auth, policy } = input;
  const credential = credentialStatus(auth);

  if (policy.remoteEmbeddings === 'disabled') {
    return {
      availability: {
        credential,
        detail: `${providerLabel(DEFAULT_OPENAI_EMBEDDING_PROVIDER)} skipped: ${policy.detail}`,
        guidance:
          'Remote embeddings are disabled by installation policy; Saga uses lexical recall. Enable embeddings.remote in the installation config to use vector recall.',
        reason: DISABLED_BY_POLICY_REASON,
        state: 'skipped',
      },
      lexicalFallback: {
        detail: 'Lexical recall is in use because remote embeddings are disabled by policy.',
        state: 'active',
      },
      mode: 'lexical-only-by-policy',
      policy,
      provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
    };
  }

  if (auth.status === 'available') {
    return {
      availability: {
        credential,
        detail: `${providerLabel(DEFAULT_OPENAI_EMBEDDING_PROVIDER)} available via ${auth.displayPath}`,
        guidance:
          'Saga will use the read-only cached Codex OPENAI_API_KEY for embedding workflows and will not refresh or rewrite Codex credentials.',
        reason: 'openai-api-key-available',
        state: 'available',
      },
      lexicalFallback: {
        detail:
          'Lexical recall remains available as a fallback if embedding generation is skipped later.',
        state: 'standby',
      },
      mode: 'vector-aware',
      policy,
      provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
    };
  }

  return {
    availability: {
      credential,
      detail: `${providerLabel(DEFAULT_OPENAI_EMBEDDING_PROVIDER)} skipped: ${auth.detail}`,
      guidance: auth.guidance,
      reason: auth.reason,
      state: 'skipped',
    },
    lexicalFallback: {
      detail: 'Lexical recall remains available while embedding generation is skipped.',
      state: 'active',
    },
    mode: 'lexical-fallback',
    policy,
    provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
  };
}

function credentialStatus(auth: CodexAuthStatus): EmbeddingCredentialStatus {
  return {
    authMode: auth.mode,
    detail:
      auth.status === 'available'
        ? `cached OPENAI_API_KEY present in ${auth.displayPath}`
        : auth.detail,
    source: 'codex-auth',
  };
}

function providerLabel(provider: EmbeddingProviderBoundary): string {
  return `${provider.id}/${provider.model} (${String(provider.dimensions)} dimensions)`;
}
