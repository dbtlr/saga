// STRANGLER TWIN (SGA-238, reconciled at SGA-249): the service-hosted HTTP MCP,
// running IN PARALLEL with apps/cli's stdio MCP. Both wire the same three Saga
// tools (@saga/mcp's transport-free JSON-RPC core) to the same @saga/db read ops
// (listRecentSessionRecords / searchSessionRecall / expandRecallContext) and the
// same presentation pipeline (compaction + agent-facing redaction + markdown).
// The stdio server resolves the workspace from the on-disk project binding; the
// service is not project-bound, so the workspace id arrives out-of-band on the
// POST /mcp request (a query parameter) and is closed over here. Recall resolves a
// query embedding under installation policy (SGA-253): vector when embeddings are
// enabled, lexical/degraded otherwise, with a real posture matching the stdio server.
// The parity test (mcp.postgres.test.ts) pins this output to the stdio server's.

import {
  expandRecallContext,
  listRecentSessionRecords,
  RecallSegmentNotFoundError,
  searchSessionRecall,
} from '@saga/db';
import type { DatabaseService, RecallSearchInput } from '@saga/db';
import { createSagaMcpServer } from '@saga/mcp';
import type {
  GetSessionContextInput,
  ListRecentSessionsInput,
  SearchSessionsInput,
} from '@saga/mcp';
import { Cause, Effect, Exit, Option } from 'effect';

import {
  compactRecallContextExpansion,
  compactRecallSearchResult,
  compactRecentSessionRecord,
  redactMcpStructuredOutput,
  renderRecentSessionsMarkdown,
  renderSessionContextMarkdown,
  renderSessionSearchMarkdown,
} from './mcp-presentation.js';
import type { RecallEmbeddingResolver } from './recall-embedding.js';

export type ServiceMcpDependencies = {
  database: DatabaseService;
  // Resolves the query embedding for search_sessions under installation policy
  // (SGA-253). Injected so the running service supplies the real policy-gated
  // resolver and tests supply a deterministic one; a search never resolves an
  // embedding until the workspace scope is validated, so a doomed request causes
  // no query egress (matching the CLI ordering).
  resolveRecallEmbedding: RecallEmbeddingResolver;
  // Scopes every tool call to a workspace; supplied out-of-band on the POST /mcp
  // request (a query parameter) since the service is not project-bound. Left
  // undefined for the transport-only methods (initialize / tools/list) that never
  // touch the database; a tools/call without it fails as a JSON-RPC error.
  workspaceId: string | undefined;
};

export function createServiceMcpServer(dependencies: ServiceMcpDependencies) {
  return createSagaMcpServer({
    getSessionContext: (input) => getServiceSessionContext(dependencies, input),
    listRecentSessions: (input) => listServiceRecentSessions(dependencies, input),
    searchSessions: (input) => searchServiceSessions(dependencies, input),
  });
}

async function listServiceRecentSessions(
  dependencies: ServiceMcpDependencies,
  input: ListRecentSessionsInput,
) {
  const workspaceId = requireWorkspace(dependencies.workspaceId);
  const sessions = await runMcpRead(() =>
    listRecentSessionRecords(dependencies.database, {
      activeOnly: input.activeOnly,
      harness: input.harness,
      limit: input.limit,
      workspaceId,
    }),
  );
  return {
    markdown: renderRecentSessionsMarkdown(sessions),
    sessions: sessions.map((session) =>
      redactMcpStructuredOutput(compactRecentSessionRecord(session)),
    ),
  };
}

async function searchServiceSessions(
  dependencies: ServiceMcpDependencies,
  input: SearchSessionsInput,
) {
  // Validate the workspace scope BEFORE resolving an embedding so a request that is
  // going to fail cannot cause query egress, matching the CLI ordering.
  const workspaceId = requireWorkspace(dependencies.workspaceId);
  // Query embedding resolution is gated by installation policy (ADR-0032): the query
  // text never reaches a remote provider unless remote embeddings are enabled. Only a
  // `vector` posture carries the embedding through; never pass the ungated
  // RecallSearchInput.embeddingProvider seam here.
  const resolved = await dependencies.resolveRecallEmbedding(input.query);
  const queryEmbedding = resolved.posture.mode === 'vector' ? resolved.queryEmbedding : undefined;
  const searchInput: RecallSearchInput = {
    activityIntervalId: input.activityIntervalId,
    limit: input.limit,
    minTrigramScore: input.minTrigramScore,
    query: input.query,
    queryEmbedding,
    rawSessionRecordId: input.rawSessionRecordId,
    sessionId: input.sessionId,
    workspaceId,
  };
  const recall = await runMcpRead(() => searchSessionRecall(dependencies.database, searchInput));
  return {
    markdown: renderSessionSearchMarkdown(recall, resolved.posture),
    recall: redactMcpStructuredOutput({
      ...compactRecallSearchResult(recall),
      search: resolved.posture,
    }),
  };
}

async function getServiceSessionContext(
  dependencies: ServiceMcpDependencies,
  input: GetSessionContextInput,
) {
  const workspaceId = requireWorkspace(dependencies.workspaceId);
  const context = await runMcpRead(() =>
    expandRecallContext(dependencies.database, {
      afterTurns: input.afterTurns,
      beforeTurns: input.beforeTurns,
      segmentId: input.segmentId,
      windowTurns: input.windowTurns,
      workspaceId,
    }),
  );
  return {
    context: redactMcpStructuredOutput(compactRecallContextExpansion(context)),
    markdown: renderSessionContextMarkdown(context),
  };
}

// The canonical 8-4-4-4-12 UUID form postgres' `uuid` type accepts. Validating the
// workspace id at the boundary keeps a malformed value out of the pg cast, whose
// failure ("invalid input syntax for type uuid: …") would otherwise be wrapped into
// a typed db-error message and forwarded to the client (see runMcpRead).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A tools/call is workspace-scoped; without a valid workspace id the request cannot
// be answered. Throwing surfaces as a JSON-RPC error (code -32000) from the
// @saga/mcp core with a clean, static message — no query text reaches the database.
function requireWorkspace(workspaceId: string | undefined): string {
  if (workspaceId === undefined || workspaceId.trim() === '') {
    throw new Error('workspaceId query parameter is required for a Saga MCP tool call');
  }
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error('workspaceId query parameter must be a valid UUID');
  }
  return workspaceId;
}

// The defect-hardened runner the MCP handlers use, mirroring the /v1 routes'
// runEffect: a DEFECT (no typed failure) carries a stack / raw driver text we must
// never forward, so it is logged server-side and re-thrown as a static message that
// the @saga/mcp core surfaces as a clean -32000. Typed db failures are also
// sanitized by default — @saga/db wraps arbitrary causes (including raw pg text like
// an invalid-uuid cast) into RecallSearchError/SessionRecordQueryError MESSAGES, so
// forwarding those verbatim would leak driver text too. Only the not-found error,
// whose message is a hand-authored constant, is forwarded (it is meaningful and
// carries no driver text). The whole run is wrapped so a synchronous throw during
// Effect construction is sanitized as well.
async function runMcpRead<A, E>(makeEffect: () => Effect.Effect<A, E>): Promise<A> {
  let exit;
  try {
    exit = await Effect.runPromiseExit(makeEffect());
  } catch (cause) {
    console.error(cause);
    // The cause rides on `.cause` (never serialized into the JSON-RPC message,
    // which uses only `.message`), so no driver text reaches the client.
    throw new Error('internal error', { cause });
  }
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (error instanceof RecallSegmentNotFoundError) {
      throw new Error(error.message);
    }
    console.error(error);
    throw new Error('internal error');
  }
  console.error(Cause.pretty(exit.cause));
  throw new Error('internal error');
}

// Exported for the hardening unit test (mcp.test.ts); not part of the MCP surface.
export { runMcpRead };
