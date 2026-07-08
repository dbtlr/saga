// SGA-253: the service-side vector-recall "brain", ported from apps/cli's
// resolveRecallSearchEmbedding (recall.ts) so the service — now the sole owner of
// recall egress after the swap (SGA-249) — resolves the query embedding under the
// same ADR-0032 installation policy the stdio server used. The gate lives in
// @saga/runtime and the generator in @saga/db (both already service deps); only
// the presentation was duplicated onto the service in SGA-238, not this
// resolution step. apps/cli keeps its own copy until SGA-249 deletes it.

import { createOpenAiSessionEmbeddingGenerator } from '@saga/db';
import type { RecallQueryEmbedding } from '@saga/db';
import {
  composeEmbeddingWorkflow,
  resolveEmbeddingCredential,
  resolveEmbeddingPolicy,
} from '@saga/runtime';
import type {
  EmbeddingCredentialResolutionOptions,
  EmbeddingPolicyResolutionOptions,
} from '@saga/runtime';

import type { RecallSearchPosture } from './mcp-presentation.js';

// The resolved query embedding plus the posture the service stamps onto the recall
// response. Only a `vector` posture carries a `queryEmbedding`; every lexical or
// degraded posture leaves it undefined so no vector path is taken.
export type ResolvedRecallEmbedding = {
  posture: RecallSearchPosture;
  queryEmbedding?: RecallQueryEmbedding | undefined;
};

// Posture when embedding resolution is deliberately skipped because an injected
// searchRecall seam is in use without an injected resolver (a dependency-injection
// path only; never a real search). Mirrors the CLI sentinel of the same name.
export const RECALL_EMBEDDING_NOT_ATTEMPTED: ResolvedRecallEmbedding = Object.freeze({
  posture: Object.freeze({
    detail: 'embedding resolution not attempted',
    mode: 'lexical',
    reason: 'not-attempted',
  }),
});

// Posture when a request explicitly asks for lexical recall (the API `mode:'lexical'`
// force, the wire equivalent of the CLI's `--no-embeddings`). No egress is attempted.
export const RECALL_EMBEDDING_DISABLED_BY_FLAG: ResolvedRecallEmbedding = Object.freeze({
  posture: Object.freeze({ mode: 'lexical', reason: 'disabled-by-flag' }),
});

// The function shape the service injects as a dependency so tests can supply a
// deterministic resolver (no remote egress) and the running service supplies the
// real policy-gated one.
export type RecallEmbeddingResolver = (query: string) => Promise<ResolvedRecallEmbedding>;

export type ResolveServiceRecallEmbeddingOptions = {
  authOptions?: EmbeddingCredentialResolutionOptions | undefined;
  fetchImpl?: typeof fetch | undefined;
  policyOptions?: EmbeddingPolicyResolutionOptions | undefined;
};

export async function resolveServiceRecallEmbedding(
  query: string,
  options: ResolveServiceRecallEmbeddingOptions = {},
): Promise<ResolvedRecallEmbedding> {
  // Installation policy gates remote embedding data flow: when remote embeddings are not
  // enabled, the recall query text is never sent to the remote provider (ADR 0032).
  // resolveEmbeddingCredential only reads local env/config/credential files; it performs
  // no remote calls.
  const credential = resolveEmbeddingCredential(options.authOptions);
  const workflow = composeEmbeddingWorkflow({
    credential,
    policy: resolveEmbeddingPolicy(options.policyOptions),
  });

  if (workflow.mode === 'lexical-only-by-policy') {
    return {
      posture: {
        detail: workflow.availability.detail,
        mode: 'lexical',
        reason: 'disabled-by-policy',
      },
    };
  }

  if (workflow.mode === 'lexical-fallback' || credential.status !== 'available') {
    return {
      posture: {
        detail: workflow.availability.detail,
        mode: 'degraded',
        reason: workflow.availability.reason,
      },
    };
  }

  const generator = createOpenAiSessionEmbeddingGenerator({
    apiKey: credential.apiKey,
    fetch: options.fetchImpl,
  });
  try {
    const [output] = await generator.embedSegments([
      {
        inputHash: 'query',
        segmentId: 'query',
        text: query,
      },
    ]);
    if (output === undefined) {
      return {
        posture: {
          detail: 'embedding provider returned no query embedding',
          mode: 'degraded',
          reason: 'embedding-error',
        },
      };
    }
    return {
      posture: { mode: 'vector' },
      queryEmbedding: {
        dimensions: generator.provider.dimensions,
        model: generator.provider.model,
        provider: generator.provider.id,
        vector: output.embedding,
      },
    };
  } catch (error) {
    return {
      posture: {
        detail: truncate(error instanceof Error ? error.message : String(error), 200),
        mode: 'degraded',
        reason: 'embedding-error',
      },
    };
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
