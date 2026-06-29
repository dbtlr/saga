import { createHash } from 'node:crypto';

import {
  DEFAULT_OPENAI_EMBEDDING_PROVIDER,
  inspectEmbeddingWorkflow,
  resolveCodexAuth,
  type CodexAuthResolutionOptions,
  type EmbeddingPolicyResolutionOptions,
  type EmbeddingProviderBoundary,
} from '@saga/runtime';
import { sql } from 'drizzle-orm';
import { Data, Effect } from 'effect';

import type { DatabaseError, DatabaseService } from './database.js';
import { sessionSegmentEmbeddings } from './schema.js';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;
const INPUT_HASH_VERSION = 1;
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

type JsonRecord = Record<string, unknown>;

interface OpenAiEmbeddingResponseEntry {
  embedding: number[];
  index: number;
}

export interface SessionEmbeddingGeneratorInput {
  inputHash: string;
  segmentId: string;
  text: string;
}

export interface SessionEmbeddingGeneratorOutput {
  embedding: readonly number[];
  segmentId: string;
}

export interface SessionEmbeddingGenerator {
  embedSegments: (
    inputs: readonly SessionEmbeddingGeneratorInput[],
  ) => Promise<readonly SessionEmbeddingGeneratorOutput[]>;
  provider: EmbeddingProviderBoundary;
}

export interface OpenAiSessionEmbeddingGeneratorOptions {
  apiKey: string;
  fetch?: typeof fetch | undefined;
  provider?: EmbeddingProviderBoundary | undefined;
}

export interface IndexSessionSegmentEmbeddingsInput {
  activityIntervalId?: string | undefined;
  authOptions?: CodexAuthResolutionOptions | undefined;
  generator?: SessionEmbeddingGenerator | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
  policyOptions?: EmbeddingPolicyResolutionOptions | undefined;
  rawSessionRecordId?: string | undefined;
  sessionId?: string | undefined;
  workspaceId: string;
}

export interface SessionEmbeddingIndexResult {
  eligibleCount: number;
  existingCount: number;
  indexedCount: number;
  lexicalFallback: {
    detail: string;
    state: 'active' | 'standby';
  };
  provider: EmbeddingProviderBoundary;
  skipped: {
    count: number;
    detail?: string | undefined;
    guidance?: string | undefined;
    reason?: string | undefined;
  };
  staleCount: number;
  status: 'completed' | 'skipped';
  workspaceId: string;
}

export class SessionEmbeddingIndexError extends Data.TaggedError('SessionEmbeddingIndexError')<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

interface SegmentCandidateRow {
  existing_embedding_id: string | null;
  existing_input_hash: string | null;
  raw_session_record_id: string;
  search_text: string;
  segment_id: string;
  workspace_id: string;
}

interface ResolvedEmbeddingGenerator {
  generator?: SessionEmbeddingGenerator | undefined;
  lexicalFallback: SessionEmbeddingIndexResult['lexicalFallback'];
  provider: EmbeddingProviderBoundary;
  skipped?: {
    detail: string;
    guidance: string;
    reason: string;
  };
}

export function indexSessionSegmentEmbeddings(
  service: DatabaseService,
  input: IndexSessionSegmentEmbeddingsInput,
): Effect.Effect<SessionEmbeddingIndexResult, DatabaseError | SessionEmbeddingIndexError> {
  return Effect.tryPromise({
    try: async () => {
      const limit = normalizeLimit(input.limit);
      const resolved = resolveEmbeddingGenerator(input);
      const candidates = await selectEligibleSegments(service, input, {
        limit,
        provider: resolved.provider,
      });
      const prepared = candidates.map((candidate) => ({
        ...candidate,
        inputHash: sessionSegmentEmbeddingInputHash(candidate.search_text, resolved.provider),
      }));
      const existingCount = prepared.filter(
        (candidate) => candidate.existing_input_hash === candidate.inputHash,
      ).length;
      const staleCount = prepared.filter(
        (candidate) =>
          candidate.existing_embedding_id !== null &&
          candidate.existing_input_hash !== candidate.inputHash,
      ).length;
      const pending = prepared.filter(
        (candidate) => candidate.existing_input_hash !== candidate.inputHash,
      );

      if (resolved.generator === undefined) {
        return {
          eligibleCount: prepared.length,
          existingCount,
          indexedCount: 0,
          lexicalFallback: resolved.lexicalFallback,
          provider: resolved.provider,
          skipped: {
            count: pending.length,
            detail: resolved.skipped?.detail,
            guidance: resolved.skipped?.guidance,
            reason: resolved.skipped?.reason,
          },
          staleCount,
          status: 'skipped',
          workspaceId: input.workspaceId,
        };
      }

      const outputs = await resolved.generator.embedSegments(
        pending.map((candidate) => ({
          inputHash: candidate.inputHash,
          segmentId: candidate.segment_id,
          text: candidate.search_text,
        })),
      );
      const outputBySegmentId = new Map(outputs.map((output) => [output.segmentId, output]));
      const now = input.now ?? new Date();

      if (pending.length > 0) {
        const values = pending.map((candidate) => {
          const output = outputBySegmentId.get(candidate.segment_id);
          if (output === undefined) {
            throw new SessionEmbeddingIndexError({
              message: `embedding generator did not return segment ${candidate.segment_id}`,
            });
          }
          validateEmbedding(output.embedding, resolved.provider, candidate.segment_id);
          return {
            createdAt: now,
            dimensions: resolved.provider.dimensions,
            embedding: [...output.embedding],
            inputHash: candidate.inputHash,
            metadata: embeddingMetadata({
              indexedAt: now,
              inputHashVersion: INPUT_HASH_VERSION,
              provider: resolved.provider,
            }),
            model: resolved.provider.model,
            provider: resolved.provider.id,
            rawSessionRecordId: candidate.raw_session_record_id,
            segmentId: candidate.segment_id,
            updatedAt: now,
            workspaceId: candidate.workspace_id,
          };
        });

        await service.db
          .insert(sessionSegmentEmbeddings)
          .values(values)
          .onConflictDoUpdate({
            target: [
              sessionSegmentEmbeddings.segmentId,
              sessionSegmentEmbeddings.provider,
              sessionSegmentEmbeddings.model,
              sessionSegmentEmbeddings.dimensions,
            ],
            set: {
              embedding: sql`excluded.embedding`,
              inputHash: sql`excluded.input_hash`,
              metadata: sql`excluded.metadata`,
              rawSessionRecordId: sql`excluded.raw_session_record_id`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }

      return {
        eligibleCount: prepared.length,
        existingCount,
        indexedCount: pending.length,
        lexicalFallback: resolved.lexicalFallback,
        provider: resolved.provider,
        skipped: {
          count: 0,
        },
        staleCount,
        status: 'completed',
        workspaceId: input.workspaceId,
      };
    },
    catch: (cause) =>
      cause instanceof SessionEmbeddingIndexError
        ? cause
        : new SessionEmbeddingIndexError({
            cause,
            message: `failed to index session segment embeddings: ${errorMessage(cause)}`,
          }),
  });
}

export function createOpenAiSessionEmbeddingGenerator(
  options: OpenAiSessionEmbeddingGeneratorOptions,
): SessionEmbeddingGenerator {
  const provider = options.provider ?? DEFAULT_OPENAI_EMBEDDING_PROVIDER;
  const fetchImpl = options.fetch ?? fetch;
  return {
    provider,
    embedSegments: async (inputs) => {
      if (inputs.length === 0) return [];
      const response = await fetchImpl(OPENAI_EMBEDDINGS_URL, {
        body: JSON.stringify({
          dimensions: provider.dimensions,
          input: inputs.map((input) => input.text),
          model: provider.model,
        }),
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      if (!response.ok) {
        throw new SessionEmbeddingIndexError({
          message: openAiHttpFailureMessage(response.status),
        });
      }
      const body = await readOpenAiEmbeddingResponseBody(response);
      const entries = parseOpenAiEmbeddingResponse(body);
      if (entries.length !== inputs.length) {
        throw new SessionEmbeddingIndexError({
          message: `OpenAI returned ${String(entries.length)} embeddings for ${String(inputs.length)} inputs`,
        });
      }
      const embeddingsByInputIndex = new Map<number, number[]>();
      for (const entry of entries) {
        if (entry.index >= inputs.length) {
          throw new SessionEmbeddingIndexError({
            message: `OpenAI returned embedding for out-of-range input index ${String(entry.index)}`,
          });
        }
        if (embeddingsByInputIndex.has(entry.index)) {
          throw new SessionEmbeddingIndexError({
            message: `OpenAI returned duplicate embedding for input index ${String(entry.index)}`,
          });
        }
        embeddingsByInputIndex.set(entry.index, entry.embedding);
      }
      return inputs.map((input, index) => ({
        embedding: requiredEmbeddingForInputIndex(embeddingsByInputIndex, index),
        segmentId: input.segmentId,
      }));
    },
  };
}

export function sessionSegmentEmbeddingInputHash(
  text: string,
  provider: EmbeddingProviderBoundary,
): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        dimensions: provider.dimensions,
        inputHashVersion: INPUT_HASH_VERSION,
        model: provider.model,
        provider: provider.id,
        text,
      }),
    )
    .digest('hex')}`;
}

async function selectEligibleSegments(
  service: DatabaseService,
  input: IndexSessionSegmentEmbeddingsInput,
  options: {
    limit: number;
    provider: EmbeddingProviderBoundary;
  },
): Promise<SegmentCandidateRow[]> {
  return service.sql<SegmentCandidateRow[]>`
    select
      ss.id as segment_id,
      ss.workspace_id,
      ss.raw_session_record_id,
      ss.search_text,
      e.id as existing_embedding_id,
      e.input_hash as existing_input_hash
    from session_segments ss
    inner join sessions s
      on s.id = ss.session_id
      and s.workspace_id = ss.workspace_id
    inner join source_bindings sb
      on sb.id = s.source_binding_id
      and sb.workspace_id = s.workspace_id
      and sb.enabled = true
    inner join raw_session_records r
      on r.id = ss.raw_session_record_id
      and r.workspace_id = ss.workspace_id
      and r.is_active = true
    left join session_segment_embeddings e
      on e.segment_id = ss.id
      and e.provider = ${options.provider.id}
      and e.model = ${options.provider.model}
      and e.dimensions = ${options.provider.dimensions}
    where ss.workspace_id = ${input.workspaceId}
      and (${input.sessionId ?? null}::uuid is null or ss.session_id = ${input.sessionId ?? null}::uuid)
      and (${input.activityIntervalId ?? null}::uuid is null or ss.activity_interval_id = ${input.activityIntervalId ?? null}::uuid)
      and (${input.rawSessionRecordId ?? null}::uuid is null or ss.raw_session_record_id = ${input.rawSessionRecordId ?? null}::uuid)
      and btrim(ss.search_text) <> ''
    order by
      s.id asc,
      ss.activity_interval_id asc,
      ss.ordinal asc,
      ss.id asc
    limit ${options.limit}
  `;
}

function resolveEmbeddingGenerator(
  input: IndexSessionSegmentEmbeddingsInput,
): ResolvedEmbeddingGenerator {
  if (input.generator !== undefined) {
    // EGRESS SEAM: an explicitly supplied generator is the caller's chosen mechanism (e.g. a
    // fake in tests or a future local, non-remote generator), so it is not gated here. ADR
    // 0032 governs *remote* embedding data flow; the only remote generator in this package
    // (createOpenAiSessionEmbeddingGenerator) is constructed below, behind the policy gate.
    // WARNING: there is no production caller of indexSessionSegmentEmbeddings yet. When one is
    // added, it MUST NOT pass a remote generator here — let the policy-gated path below build
    // it, or resolve installation policy before supplying any remote generator.
    return {
      generator: input.generator,
      lexicalFallback: {
        detail:
          'Lexical recall remains available as a fallback if embedding generation fails later.',
        state: 'standby',
      },
      provider: input.generator.provider,
    };
  }

  // inspectEmbeddingWorkflow composes installation policy with credentials; a disabled
  // policy yields availability.state "skipped" with reason "disabled-by-policy" below.
  const workflow = inspectEmbeddingWorkflow(input.authOptions, input.policyOptions);
  if (workflow.availability.state === 'skipped') {
    return {
      lexicalFallback: workflow.lexicalFallback,
      provider: workflow.provider,
      skipped: {
        detail: workflow.availability.detail,
        guidance: workflow.availability.guidance,
        reason: workflow.availability.reason,
      },
    };
  }

  const auth = resolveCodexAuth(input.authOptions);
  if (auth.status !== 'available') {
    return {
      lexicalFallback: {
        detail: 'Lexical recall remains available while embedding generation is skipped.',
        state: 'active',
      },
      provider: workflow.provider,
      skipped: {
        detail: auth.detail,
        guidance: auth.guidance,
        reason: auth.reason,
      },
    };
  }

  return {
    generator: createOpenAiSessionEmbeddingGenerator({
      apiKey: auth.openaiApiKey,
      provider: workflow.provider,
    }),
    lexicalFallback: workflow.lexicalFallback,
    provider: workflow.provider,
  };
}

function embeddingMetadata(input: {
  indexedAt: Date;
  inputHashVersion: number;
  provider: EmbeddingProviderBoundary;
}): JsonRecord {
  return {
    indexedAt: input.indexedAt.toISOString(),
    inputHashVersion: input.inputHashVersion,
    provider: {
      dimensions: input.provider.dimensions,
      id: input.provider.id,
      model: input.provider.model,
    },
    status: 'indexed',
  };
}

function openAiHttpFailureMessage(status: number): string {
  return `OpenAI embeddings request failed with HTTP ${String(status)} (${openAiHttpFailureCategory(status)})`;
}

function openAiHttpFailureCategory(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return 'invalid request';
    case 401:
      return 'authentication failed';
    case 403:
      return 'authorization failed';
    case 408:
      return 'request timeout';
    case 409:
      return 'request conflict';
    case 429:
      return 'rate limited';
    default:
      if (status >= 400 && status < 500) return 'client error';
      if (status >= 500 && status < 600) return 'server error';
      return 'unexpected status';
  }
}

async function readOpenAiEmbeddingResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new SessionEmbeddingIndexError({
      cause,
      message: 'OpenAI embeddings response was not valid JSON',
    });
  }
}

function parseOpenAiEmbeddingResponse(value: unknown): OpenAiEmbeddingResponseEntry[] {
  if (value === null || typeof value !== 'object') {
    throw new SessionEmbeddingIndexError({
      message: 'OpenAI embeddings response was not an object',
    });
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new SessionEmbeddingIndexError({ message: 'OpenAI embeddings response missing data' });
  }
  return data.map((item, responsePosition) => {
    if (item === null || typeof item !== 'object') {
      throw new SessionEmbeddingIndexError({
        message: `OpenAI embeddings response data item ${String(responsePosition)} was not an object`,
      });
    }
    const index = (item as { index?: unknown }).index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new SessionEmbeddingIndexError({
        message: `OpenAI embeddings response data item ${String(responsePosition)} missing valid index`,
      });
    }
    const embedding = (item as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || !embedding.every((part) => typeof part === 'number')) {
      throw new SessionEmbeddingIndexError({
        message: `OpenAI embeddings response embedding at index ${String(index)} was malformed`,
      });
    }
    return { embedding, index };
  });
}

function requiredEmbeddingForInputIndex(
  embeddingsByInputIndex: ReadonlyMap<number, readonly number[]>,
  index: number,
): readonly number[] {
  const embedding = embeddingsByInputIndex.get(index);
  if (embedding === undefined) {
    throw new SessionEmbeddingIndexError({
      message: `OpenAI did not return embedding for input index ${String(index)}`,
    });
  }
  return embedding;
}

function validateEmbedding(
  embedding: readonly number[],
  provider: EmbeddingProviderBoundary,
  segmentId: string,
): void {
  if (embedding.length !== provider.dimensions) {
    throw new SessionEmbeddingIndexError({
      message: `embedding for segment ${segmentId} has ${String(embedding.length)} dimensions; expected ${String(provider.dimensions)}`,
    });
  }
  if (!embedding.every(Number.isFinite)) {
    throw new SessionEmbeddingIndexError({
      message: `embedding for segment ${segmentId} contains a non-finite value`,
    });
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SessionEmbeddingIndexError({
      message: 'embedding index limit must be a positive integer',
    });
  }
  return Math.min(limit, MAX_LIMIT);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
