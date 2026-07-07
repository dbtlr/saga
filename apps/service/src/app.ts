import {
  expandRecallContext,
  getMigrationStatus,
  getSessionDetail,
  listRecentRawEvents,
  listRecentSessionRecords,
  RecallSearchError,
  RecallSegmentNotFoundError,
  redactAgentFacingSessionValue,
  searchSessionRecall,
  SessionRecordQueryError,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import { Cause, Effect, Exit, Option } from 'effect';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

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
type ApiStatus = 400 | 403 | 404 | 413 | 500 | 503;

// A DNS-rebinding guard: an off-box attacker who lures a loopback client into
// resolving an attacker domain to 127.0.0.1 still fails the Host check. Mirrors
// server.ts's bind-gate allow-set and honors the same unsafe escape so a
// deliberately-exposed deployment (its port publish is the boundary) opts out
// (ADR-0051). Kept local rather than imported to avoid an app<->server cycle.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const UNSAFE_BIND_ENV = 'SAGA_SERVICE_UNSAFE_ALLOW_NONLOOPBACK';

// Recall is the only body-reading route; cap it so an oversized payload is
// rejected with 413 before it is buffered into memory and parsed.
const MAX_RECALL_BODY_BYTES = 1024 * 1024;

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

  // Runs before routing: reject any request whose Host header host-part is not
  // loopback, upholding ADR-0051's "unreachable off-box" guarantee against a
  // DNS-rebinding attacker. Skipped when the deployment sets the same escape the
  // bind gate honors — there the port-publish perimeter is the boundary.
  app.use('*', async (c, next) => {
    if (process.env[UNSAFE_BIND_ENV] !== '1') {
      // The node server always populates a Host header; fall back to the request
      // URL's hostname only for absent-header callers (e.g. Hono's in-process
      // app.request), where the URL host is the authority anyway.
      const host = hostHeaderHost(c.req.header('host')) ?? safeUrlHostname(c.req.url);
      if (host === undefined || !LOOPBACK_HOSTS.has(host)) {
        return c.json(errorBody('forbidden', 'host not allowed'), 403);
      }
    }
    return next();
  });

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

  app.post(
    '/v1/recall',
    bodyLimit({
      maxSize: MAX_RECALL_BODY_BYTES,
      onError: (c) => c.json(errorBody('bad_request', 'request body too large'), 413),
    }),
    async (c) => {
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
      return c.json(redactAgentFacingSessionValue(result));
    },
  );

  app.get('/v1/sessions', async (c) => {
    const database = requireDatabase();
    const rows = await runRead(
      listRecentSessionRecords(database, {
        activeOnly: queryBoolean(c, 'activeOnly'),
        harness: c.req.query('harness'),
        limit: queryInt(c, 'limit', { min: 1 }),
        workspaceId: requireWorkspaceId(c),
      }),
    );
    return c.json(redactAgentFacingSessionValue(rows));
  });

  app.get('/v1/sessions/:id/context', async (c) => {
    const database = requireDatabase();
    const result = await runRead(
      expandRecallContext(database, {
        afterTurns: queryInt(c, 'afterTurns', { min: 0 }),
        beforeTurns: queryInt(c, 'beforeTurns', { min: 0 }),
        // `:id` is the anchor SEGMENT id, matching expandRecallContext / the MCP
        // get_session_context handler — not a session id.
        segmentId: c.req.param('id'),
        windowTurns: queryInt(c, 'windowTurns', { min: 0 }),
        workspaceId: requireWorkspaceId(c),
      }),
    );
    return c.json(redactAgentFacingSessionValue(result));
  });

  app.get('/v1/sessions/:id', async (c) => {
    const database = requireDatabase();
    const detail = await runRead(
      getSessionDetail(database, {
        id: c.req.param('id'),
        includeRawBody: queryBoolean(c, 'includeRawBody'),
        maxRawRecords: queryInt(c, 'maxRawRecords', { min: 1 }),
        maxSegmentsPerTurn: queryInt(c, 'maxSegmentsPerTurn', { min: 1 }),
        maxTurns: queryInt(c, 'maxTurns', { min: 1 }),
        workspaceId: requireWorkspaceId(c),
      }),
    );
    return c.json(redactAgentFacingSessionValue(detail));
  });

  app.get('/v1/events', async (c) => {
    const database = requireDatabase();
    const rows = await runRead(
      listRecentRawEvents(database, {
        limit: queryInt(c, 'limit', { min: 1 }),
        workspaceId: requireWorkspaceId(c),
      }),
    );
    return c.json(redactAgentFacingSessionValue(rows));
  });

  app.notFound((c) => c.json(errorBody('not_found', `no route for ${c.req.path}`), 404));

  app.onError((cause, c) => {
    if (cause instanceof HttpError) {
      return c.json(errorBody(cause.code, cause.message), cause.status);
    }
    // Never surface an unexpected cause to the client; log it server-side and
    // return a static body so no stack or driver text leaks.
    console.error(cause);
    return c.json(errorBody('internal', 'internal error'), 500);
  });

  return app;
}

// Extract the host-part of a Host header, dropping any `:port` and IPv6 brackets
// so it can be matched against the loopback allow-set.
function hostHeaderHost(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const trimmed = header.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? undefined : trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function safeUrlHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
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
  // A defect (no typed failure) carries a stack we must not leak; log it
  // server-side and throw a 500 whose static message crosses the wire.
  console.error(Cause.pretty(exit.cause));
  throw new HttpError(500, 'internal', 'internal error');
}

function mapDbError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  // A bad or missing id surfaces as a query error → 404; a malformed recall input
  // surfaces as a recall error → 400; everything else is an internal fault → 500.
  // The 404/400 branches carry hand-authored, validation-grade messages; the 500
  // branch must not forward raw db/driver text, so it logs the cause and returns
  // a static body instead.
  if (error instanceof SessionRecordQueryError || error instanceof RecallSegmentNotFoundError) {
    return new HttpError(404, 'not_found', message);
  }
  if (error instanceof RecallSearchError) {
    return new HttpError(400, 'bad_request', message);
  }
  console.error(error);
  return new HttpError(500, 'internal', 'internal error');
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
  // Number.isSafeInteger rejects both non-integers and values past 2^53, so an
  // oversized body int is a 400 here rather than a downstream overflow/500.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
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

// Strict integer query parse: the app layer owns format/safety/lower-bound (the
// db layer owns the upper clamp). Only a bare decimal string passes — leading
// `/^\d+$/` on the trimmed raw rejects blank/whitespace, signs, hex (`0x10`),
// and scientific (`1e9`) forms before Number, and Number.isSafeInteger rejects
// values past 2^53 so an oversized limit is a 400, never a 500.
function queryInt(c: Context, label: string, options: { min: number }): number | undefined {
  const raw = c.req.query(label);
  if (raw === undefined) {
    return undefined;
  }
  const noun = options.min >= 1 ? 'a positive integer' : 'a non-negative integer';
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new HttpError(400, 'bad_request', `${label} must be ${noun}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < options.min) {
    throw new HttpError(400, 'bad_request', `${label} must be ${noun}`);
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
