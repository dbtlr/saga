import {
  expandRecallContext,
  getMigrationStatus,
  getSessionDetail,
  listRecentRawEvents,
  listRecentSessionRecords,
  RecallSearchError,
  searchSessionRecall,
  SessionRecordQueryError,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import { Cause, Effect, Exit, Option } from 'effect';
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { JobStatus } from './jobs/job-runner.js';

export type HealthJobStatus = Omit<JobStatus, 'lastRunAt'> & { lastRunAt: string | null };

export type HealthPayload = {
  jobs: HealthJobStatus[];
  ok: true;
  service: 'saga';
  uptimeSeconds: number;
};

export type SagaAppDependencies = {
  // The API database connection, or undefined until it is acquired post-listen.
  // A /v1 request that arrives before it is ready gets a clean 503.
  getDatabase: () => DatabaseService | undefined;
  jobStatus: () => HealthJobStatus[];
  startedAt: number;
  version: string;
};

// The status codes the API emits; each is a Hono ContentfulStatusCode, so an
// HttpError.status flows into c.json without a cast.
type ApiStatus = 400 | 404 | 500 | 503;

// A response error carrying the HTTP status and the machine code echoed in the
// `{ error: { code, message } }` body. Handlers throw it for validation misses;
// runRead throws it for mapped db failures. onError renders every one uniformly.
class HttpError extends Error {
  readonly code: string;
  readonly status: ApiStatus;

  constructor(status: ApiStatus, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
  }
}

export function createSagaApp(dependencies: SagaAppDependencies): Hono {
  const app = new Hono();

  const uptimeSeconds = (): number => Math.floor((Date.now() - dependencies.startedAt) / 1000);

  const requireDatabase = (): DatabaseService => {
    const database = dependencies.getDatabase();
    if (database === undefined) {
      throw new HttpError(503, 'unavailable', 'saga service database is not ready');
    }
    return database;
  };

  // Byte-compatible with the pre-Hono node:http handler: same key order, same
  // `application/json` content-type (no charset), same body. launchd polls this.
  app.get('/health', (c) => {
    const payload: HealthPayload = {
      jobs: dependencies.jobStatus(),
      ok: true,
      service: 'saga',
      uptimeSeconds: uptimeSeconds(),
    };
    return c.body(JSON.stringify(payload), 200, { 'content-type': 'application/json' });
  });

  app.get('/v1/info', async (c) => {
    const database = requireDatabase();
    const migrations = await runRead(getMigrationStatus(database));
    return c.json({
      migrations: {
        applied: migrations.applied,
        compatible: migrations.compatible,
        expected: migrations.expected,
      },
      uptimeSeconds: uptimeSeconds(),
      version: dependencies.version,
    });
  });

  app.post('/v1/recall', async (c) => {
    const database = requireDatabase();
    const body = await readJsonBody(c);
    const query = requireString(body.query, 'query');
    const mode = optionalString(body.mode, 'mode');
    if (mode !== undefined && mode !== 'lexical') {
      // Vector recall needs a query-embedding egress that arrives in a later
      // slice; only the lexical path crosses this boundary today.
      throw new HttpError(400, 'bad_request', "mode must be 'lexical'");
    }
    const result = await runRead(
      searchSessionRecall(database, {
        activityIntervalId: optionalString(body.activityIntervalId, 'activityIntervalId'),
        limit: optionalPositiveInt(body.limit, 'limit'),
        minTrigramScore: optionalScore(body.minTrigramScore, 'minTrigramScore'),
        query,
        rawSessionRecordId: optionalString(body.rawSessionRecordId, 'rawSessionRecordId'),
        sessionId: optionalString(body.sessionId, 'sessionId'),
        vectorCandidateLimit: optionalPositiveInt(
          body.vectorCandidateLimit,
          'vectorCandidateLimit',
        ),
        workspaceId: requireString(body.workspaceId, 'workspaceId'),
      }),
    );
    return c.json(result);
  });

  app.get('/v1/sessions', async (c) => {
    const database = requireDatabase();
    const rows = await runRead(
      listRecentSessionRecords(database, {
        activeOnly: queryBoolean(c, 'activeOnly'),
        harness: c.req.query('harness'),
        limit: queryPositiveInt(c, 'limit'),
        workspaceId: requireWorkspaceId(c),
      }),
    );
    return c.json(rows);
  });

  app.get('/v1/sessions/:id/context', async (c) => {
    const database = requireDatabase();
    const result = await runRead(
      expandRecallContext(database, {
        afterTurns: queryNonNegativeInt(c, 'afterTurns'),
        beforeTurns: queryNonNegativeInt(c, 'beforeTurns'),
        // `:id` is the anchor SEGMENT id, matching expandRecallContext / the MCP
        // get_session_context handler — not a session id.
        segmentId: c.req.param('id'),
        windowTurns: queryNonNegativeInt(c, 'windowTurns'),
        workspaceId: requireWorkspaceId(c),
      }),
    );
    return c.json(result);
  });

  app.get('/v1/sessions/:id', async (c) => {
    const database = requireDatabase();
    const detail = await runRead(
      getSessionDetail(database, {
        id: c.req.param('id'),
        includeRawBody: queryBoolean(c, 'includeRawBody'),
        maxRawRecords: queryPositiveInt(c, 'maxRawRecords'),
        maxSegmentsPerTurn: queryPositiveInt(c, 'maxSegmentsPerTurn'),
        maxTurns: queryPositiveInt(c, 'maxTurns'),
        workspaceId: requireWorkspaceId(c),
      }),
    );
    return c.json(detail);
  });

  app.get('/v1/events', async (c) => {
    const database = requireDatabase();
    const rows = await runRead(
      listRecentRawEvents(database, {
        limit: queryPositiveInt(c, 'limit'),
        workspaceId: requireWorkspaceId(c),
      }),
    );
    return c.json(rows);
  });

  app.notFound((c) => c.json(errorBody('not_found', `no route for ${c.req.path}`), 404));

  app.onError((cause, c) => {
    if (cause instanceof HttpError) {
      return c.json(errorBody(cause.code, cause.message), cause.status);
    }
    return c.json(
      errorBody('internal', cause instanceof Error ? cause.message : String(cause)),
      500,
    );
  });

  return app;
}

// Run a @saga/db read Effect and surface its typed failure as an HttpError with a
// stable code/status. Keeps every handler a thin, uniform mapping.
async function runRead<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    throw mapDbError(failure.value);
  }
  throw new HttpError(500, 'internal', Cause.pretty(exit.cause));
}

function mapDbError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  // A bad or missing id surfaces as a query error → 404; a malformed recall input
  // surfaces as a recall error → 400; everything else is an internal fault → 500.
  if (error instanceof SessionRecordQueryError) {
    return new HttpError(404, 'not_found', message);
  }
  if (error instanceof RecallSearchError) {
    return new HttpError(400, 'bad_request', message);
  }
  return new HttpError(500, 'internal', message);
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new HttpError(400, 'bad_request', 'request body must be JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_request', 'request body must be a JSON object');
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- external JSON; every field is validated below
  return parsed as Record<string, unknown>;
}

function requireWorkspaceId(c: Context): string {
  return requireString(c.req.query('workspaceId'), 'workspaceId');
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'bad_request', `${label} is required`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'bad_request', `${label} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, 'bad_request', `${label} must be a positive integer`);
  }
  return value;
}

function optionalScore(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpError(400, 'bad_request', `${label} must be between 0 and 1`);
  }
  return value;
}

function queryPositiveInt(c: Context, label: string): number | undefined {
  const raw = c.req.query(label);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, 'bad_request', `${label} must be a positive integer`);
  }
  return parsed;
}

function queryNonNegativeInt(c: Context, label: string): number | undefined {
  const raw = c.req.query(label);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, 'bad_request', `${label} must be a non-negative integer`);
  }
  return parsed;
}

function queryBoolean(c: Context, label: string): boolean | undefined {
  const raw = c.req.query(label);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new HttpError(400, 'bad_request', `${label} must be 'true' or 'false'`);
}
