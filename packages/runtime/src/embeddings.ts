import {
  resolveCodexAuth,
  type CodexAuthResolutionOptions,
  type CodexAuthStatus,
} from "./codex-auth.js";

export type EmbeddingProviderId = "openai";
export type EmbeddingAvailabilityState = "available" | "skipped";
export type LexicalFallbackState = "active" | "standby";

export interface EmbeddingProviderBoundary {
  dimensions: number;
  id: EmbeddingProviderId;
  model: string;
}

export interface EmbeddingCredentialStatus {
  authMode: CodexAuthStatus["mode"];
  detail: string;
  source: "codex-auth";
}

export interface EmbeddingWorkflowAvailability {
  credential: EmbeddingCredentialStatus;
  detail: string;
  guidance: string;
  reason: string;
  state: EmbeddingAvailabilityState;
}

export interface EmbeddingWorkflowBoundary {
  availability: EmbeddingWorkflowAvailability;
  lexicalFallback: {
    detail: string;
    state: LexicalFallbackState;
  };
  provider: EmbeddingProviderBoundary;
}

export const DEFAULT_OPENAI_EMBEDDING_PROVIDER: EmbeddingProviderBoundary = {
  dimensions: 1536,
  id: "openai",
  model: "text-embedding-3-small",
};

export function inspectEmbeddingWorkflow(
  options: CodexAuthResolutionOptions = {},
): EmbeddingWorkflowBoundary {
  return embeddingWorkflowFromCodexAuth(resolveCodexAuth(options));
}

export function embeddingWorkflowFromCodexAuth(auth: CodexAuthStatus): EmbeddingWorkflowBoundary {
  if (auth.status === "available") {
    return {
      availability: {
        credential: {
          authMode: auth.mode,
          detail: `cached OPENAI_API_KEY present in ${auth.displayPath}`,
          source: "codex-auth",
        },
        detail: `${providerLabel(DEFAULT_OPENAI_EMBEDDING_PROVIDER)} available via ${auth.displayPath}`,
        guidance:
          "Saga will use the read-only cached Codex OPENAI_API_KEY for embedding workflows and will not refresh or rewrite Codex credentials.",
        reason: "openai-api-key-available",
        state: "available",
      },
      lexicalFallback: {
        detail:
          "Lexical recall remains available as a fallback if embedding generation is skipped later.",
        state: "standby",
      },
      provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
    };
  }

  return {
    availability: {
      credential: {
        authMode: auth.mode,
        detail: auth.detail,
        source: "codex-auth",
      },
      detail: `${providerLabel(DEFAULT_OPENAI_EMBEDDING_PROVIDER)} skipped: ${auth.detail}`,
      guidance: auth.guidance,
      reason: auth.reason,
      state: "skipped",
    },
    lexicalFallback: {
      detail: "Lexical recall remains available while embedding generation is skipped.",
      state: "active",
    },
    provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
  };
}

function providerLabel(provider: EmbeddingProviderBoundary): string {
  return `${provider.id}/${provider.model} (${String(provider.dimensions)} dimensions)`;
}
