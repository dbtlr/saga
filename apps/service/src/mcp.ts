// STRANGLER TWIN (SGA-238, reconciled at SGA-249): the service-hosted HTTP MCP,
// running IN PARALLEL with apps/cli's stdio MCP. Both wire the same three Saga
// tools (@saga/mcp's transport-free JSON-RPC core) to the same @saga/db read ops
// (listRecentSessionRecords / searchSessionRecall / expandRecallContext) and the
// same presentation pipeline (compaction + agent-facing redaction + markdown).
// The stdio server resolves the workspace from the on-disk project binding; the
// service is not project-bound, so the workspace id arrives out-of-band on the
// POST /mcp request (a query parameter) and is closed over here. Recall is
// LEXICAL-ONLY for now: vector query egress is deferred, so the posture is the
// fixed SERVICE_LEXICAL_POSTURE rather than the CLI's env/policy-resolved stance.
// The parity test (mcp.postgres.test.ts) pins this output to the stdio server's.

import { expandRecallContext, listRecentSessionRecords, searchSessionRecall } from '@saga/db';
import type { DatabaseService, RecallSearchInput } from '@saga/db';
import { createSagaMcpServer } from '@saga/mcp';
import type {
  GetSessionContextInput,
  ListRecentSessionsInput,
  SearchSessionsInput,
} from '@saga/mcp';
import { Effect } from 'effect';

import {
  compactRecallContextExpansion,
  compactRecallSearchResult,
  compactRecentSessionRecord,
  redactMcpStructuredOutput,
  renderRecentSessionsMarkdown,
  renderSessionContextMarkdown,
  renderSessionSearchMarkdown,
  SERVICE_LEXICAL_POSTURE,
} from './mcp-presentation.js';

export type ServiceMcpDependencies = {
  database: DatabaseService;
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
  const sessions = await Effect.runPromise(
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
  const workspaceId = requireWorkspace(dependencies.workspaceId);
  // LEXICAL-ONLY: never resolve or pass a query embedding here — vector recall
  // egress is a later slice. The posture is the fixed lexical stance, mirrored in
  // both the markdown and the structured `search` field the CLI stamps.
  const posture = SERVICE_LEXICAL_POSTURE;
  const searchInput: RecallSearchInput = {
    activityIntervalId: input.activityIntervalId,
    limit: input.limit,
    minTrigramScore: input.minTrigramScore,
    query: input.query,
    rawSessionRecordId: input.rawSessionRecordId,
    sessionId: input.sessionId,
    workspaceId,
  };
  const recall = await Effect.runPromise(searchSessionRecall(dependencies.database, searchInput));
  return {
    markdown: renderSessionSearchMarkdown(recall, posture),
    recall: redactMcpStructuredOutput({
      ...compactRecallSearchResult(recall),
      search: posture,
    }),
  };
}

async function getServiceSessionContext(
  dependencies: ServiceMcpDependencies,
  input: GetSessionContextInput,
) {
  const workspaceId = requireWorkspace(dependencies.workspaceId);
  const context = await Effect.runPromise(
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

// A tools/call is workspace-scoped; without a workspace id the request cannot be
// answered. Throwing surfaces as a JSON-RPC error (code -32000) from the @saga/mcp
// core, matching how the stdio server reports a missing project binding.
function requireWorkspace(workspaceId: string | undefined): string {
  if (workspaceId === undefined || workspaceId.trim() === '') {
    throw new Error('workspaceId query parameter is required for a Saga MCP tool call');
  }
  return workspaceId;
}
