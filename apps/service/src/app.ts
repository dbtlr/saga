import type { RawEventEnvelope, TrustLevel } from '@saga/contracts';
import {
  expandRecallContext,
  findRawEventByEnvelopeKey,
  getMigrationStatus,
  getSessionDetail,
  insertRawEvent,
  listRecentRawEvents,
  listRecentSessionRecords,
  RawEventInsertError,
  RawSessionImportError,
  RecallSearchError,
  RecallSegmentNotFoundError,
  redactAgentFacingSessionValue,
  searchSessionRecall,
  SessionRecordQueryError,
  storeRawSessionRecord,
} from '@saga/db';
import type { DatabaseService, RawEvent, RawSessionImportInput } from '@saga/db';
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

// Ingest snapshots carry whole transcript bodies (and a batch of them), so the
// cap is larger than recall's — still bounded so an oversized batch is a 413
// before it is buffered and parsed.
const MAX_INGEST_BODY_BYTES = 8 * 1024 * 1024;

// A per-item ack (SGA-238). It never echoes the envelope payload or any session
// content back to the caller — only stable ids and a status — so the ingest
// response needs no agent-facing redaction pass.
type IngestItemResult = {
  code?: string;
  externalEventId: string;
  rawEventId?: string;
  rawSessionRecordId?: string;
  status: 'stored' | 'duplicate' | 'error';
};

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
      // Host comparison is case-insensitive (RFC 3986), so a legitimate
      // `Host: LOCALHOST` or an upper-case authority is loopback too.
      if (host === undefined || !LOOPBACK_HOSTS.has(host.toLowerCase())) {
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

  // The WRITE path (SGA-238): a dumb raw store. Each item is a raw event (always
  // stored, idempotent on the 4-col tuple) plus an optional session snapshot
  // (stored, NOT derived — the extraction job derives it). The batch is
  // non-transactional across items: one bad item gets `status:'error'` while its
  // siblings still succeed. Acks carry only ids + a status, never payloads, so no
  // agent-facing redaction is applied.
  app.post(
    '/v1/ingest',
    bodyLimit({
      maxSize: MAX_INGEST_BODY_BYTES,
      onError: (c) => c.json(errorBody('bad_request', 'request body too large'), 413),
    }),
    async (c) => {
      const database = requireDatabase();
      const body = await readJsonBody(c);
      if (!Array.isArray(body.items)) {
        throw new HttpError(400, 'bad_request', 'items must be an array');
      }
      const results: IngestItemResult[] = [];
      for (const item of body.items) {
        // eslint-disable-next-line no-await-in-loop -- ordered, per-item isolation
        results.push(await ingestOneItem(database, item));
      }
      return c.json({ results });
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
    // URL.hostname keeps IPv6 brackets ('[::1]'); strip them so the result
    // matches the unbracketed loopback entries, like the Host-header path does.
    const hostname = new URL(url).hostname;
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
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

// Store one ingest item and return its ack. Isolated: any failure becomes an
// `error` ack for THIS item rather than throwing, so the batch stays partial-safe.
async function ingestOneItem(
  database: DatabaseService,
  rawItem: unknown,
): Promise<IngestItemResult> {
  const item = asObject(rawItem);
  // Pull the ack key up front so even a failed item can be attributed.
  const externalEventId = readEnvelopeExternalEventId(item?.envelope);
  try {
    if (item === undefined) {
      throw new HttpError(400, 'bad_request', 'each ingest item must be an object');
    }
    const envelope = coerceEnvelope(item.envelope);
    const existing = await runIngestEffect(
      findRawEventByEnvelopeKey(database, {
        externalEventId: envelope.externalEventId,
        sourceId: envelope.sourceId,
        sourceType: envelope.sourceType,
        workspaceId: envelope.workspaceId,
      }),
    );
    const alreadyStored = existing !== undefined;
    const rawEventRow = await runIngestEffect(insertRawEvent(database, envelope));

    let rawSessionRecordId: string | undefined;
    let snapshotInserted = false;
    if (item.snapshot !== undefined && item.snapshot !== null) {
      const snapshot = coerceSnapshot(item.snapshot);
      const stored = await runIngestEffect(
        storeRawSessionRecord(database, buildStoreInput(envelope, snapshot, rawEventRow)),
      );
      rawSessionRecordId = stored.rawSessionRecordId;
      snapshotInserted = stored.operation === 'inserted';
    }

    // A duplicate only when nothing new landed: the raw event already existed and
    // (there was no snapshot, or the snapshot row already existed too).
    const status: IngestItemResult['status'] =
      !alreadyStored || snapshotInserted ? 'stored' : 'duplicate';
    return {
      externalEventId,
      rawEventId: rawEventRow.id,
      status,
      ...(rawSessionRecordId !== undefined ? { rawSessionRecordId } : {}),
    };
  } catch (cause) {
    return { code: ingestErrorCode(cause), externalEventId, status: 'error' };
  }
}

// Run a @saga/db write Effect for one item. A typed failure is rethrown so the
// per-item catch maps it to an error code; a defect is logged (never leaked) and
// surfaced as a generic internal error for that item.
async function runIngestEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    throw failure.value;
  }
  console.error(Cause.pretty(exit.cause));
  throw new HttpError(500, 'internal', 'internal error');
}

function ingestErrorCode(cause: unknown): string {
  if (cause instanceof RawEventInsertError) {
    return 'raw_event_insert';
  }
  if (cause instanceof RawSessionImportError) {
    return 'raw_session_store';
  }
  if (cause instanceof HttpError) {
    return cause.code;
  }
  return 'internal';
}

function readEnvelopeExternalEventId(rawEnvelope: unknown): string {
  const envelope = asObject(rawEnvelope);
  const value = envelope?.externalEventId;
  return typeof value === 'string' ? value : '';
}

// The service re-derives capturedAt (from the raw event's occurredAt) and the
// settlement trigger (the inserted raw event's id) here, so the client never
// sends them; workspaceId/sourceBindingId ride on the envelope. Everything else
// — the local-machine author/host identity and the transcript body — comes from
// the snapshot because the service cannot reconstruct it (see the CLI capture
// path). storeRawSessionRecord stores this WITHOUT deriving turns/segments.
function buildStoreInput(
  envelope: RawEventEnvelope,
  snapshot: IngestSnapshot,
  rawEventRow: RawEvent,
): RawSessionImportInput {
  return {
    activity: {
      hookEventName: snapshot.activity?.hookEventName,
      sessionStartSource: snapshot.activity?.sessionStartSource,
      settlementTriggerRawEventId: rawEventRow.id,
    },
    author: snapshot.author,
    capturedAt: rawEventRow.occurredAt,
    contentType: snapshot.contentType,
    harness: snapshot.harness,
    harnessMetadata: snapshot.harnessMetadata,
    harnessSessionId: snapshot.harnessSessionId,
    host: snapshot.host,
    locator: snapshot.locator,
    metadata: snapshot.metadata,
    model: snapshot.model,
    provenance: snapshot.provenance,
    rawContent: snapshot.rawContent,
    sourceBindingId: envelope.sourceBindingId,
    status: snapshot.status,
    title: snapshot.title,
    workspaceId: envelope.workspaceId,
  };
}

type IngestSnapshot = {
  activity?:
    | { hookEventName?: string | undefined; sessionStartSource?: string | undefined }
    | undefined;
  author: {
    displayName?: string | undefined;
    externalSubject?: string | undefined;
    handle: string;
  };
  contentType: 'json' | 'jsonl' | 'text';
  harness: 'claude' | 'codex';
  harnessMetadata?: Record<string, unknown> | undefined;
  harnessSessionId?: string | undefined;
  host: { id: string; label?: string | undefined; projectRoot?: string | undefined };
  locator?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  provenance?: Record<string, unknown> | undefined;
  rawContent: string;
  status?: 'active' | 'completed' | undefined;
  title?: string | undefined;
};

function coerceEnvelope(raw: unknown): RawEventEnvelope {
  const env = asObject(raw);
  if (env === undefined) {
    throw new HttpError(400, 'bad_request', 'item.envelope must be an object');
  }
  return {
    actorId: requireString(env.actorId, 'envelope.actorId'),
    eventType: requireString(env.eventType, 'envelope.eventType'),
    externalEventId: requireString(env.externalEventId, 'envelope.externalEventId'),
    ingestedAt: optionalString(env.ingestedAt, 'envelope.ingestedAt'),
    occurredAt: requireString(env.occurredAt, 'envelope.occurredAt'),
    payload: requireRecord(env.payload, 'envelope.payload'),
    provenance: requireRecord(env.provenance, 'envelope.provenance'),
    sessionId: optionalString(env.sessionId, 'envelope.sessionId'),
    sourceBindingId: requireString(env.sourceBindingId, 'envelope.sourceBindingId'),
    sourceId: requireString(env.sourceId, 'envelope.sourceId'),
    sourceType: requireString(env.sourceType, 'envelope.sourceType'),
    traceId: optionalString(env.traceId, 'envelope.traceId'),
    trustLevel: coerceTrustLevel(env.trustLevel),
    workspaceId: requireString(env.workspaceId, 'envelope.workspaceId'),
  };
}

function coerceSnapshot(raw: unknown): IngestSnapshot {
  const s = asObject(raw);
  if (s === undefined) {
    throw new HttpError(400, 'bad_request', 'item.snapshot must be an object');
  }
  const author = asObject(s.author);
  if (author === undefined) {
    throw new HttpError(400, 'bad_request', 'snapshot.author must be an object');
  }
  const host = asObject(s.host);
  if (host === undefined) {
    throw new HttpError(400, 'bad_request', 'snapshot.host must be an object');
  }
  const activity = asObject(s.activity);
  return {
    activity:
      activity === undefined
        ? undefined
        : {
            hookEventName: optionalString(
              activity.hookEventName,
              'snapshot.activity.hookEventName',
            ),
            sessionStartSource: optionalString(
              activity.sessionStartSource,
              'snapshot.activity.sessionStartSource',
            ),
          },
    author: {
      displayName: optionalString(author.displayName, 'snapshot.author.displayName'),
      externalSubject: optionalString(author.externalSubject, 'snapshot.author.externalSubject'),
      handle: requireString(author.handle, 'snapshot.author.handle'),
    },
    contentType: coerceEnum(
      s.contentType,
      ['json', 'jsonl', 'text'] as const,
      'snapshot.contentType',
    ),
    harness: coerceEnum(s.harness, ['claude', 'codex'] as const, 'snapshot.harness'),
    harnessMetadata: optionalRecord(s.harnessMetadata, 'snapshot.harnessMetadata'),
    harnessSessionId: optionalString(s.harnessSessionId, 'snapshot.harnessSessionId'),
    host: {
      id: requireString(host.id, 'snapshot.host.id'),
      label: optionalString(host.label, 'snapshot.host.label'),
      projectRoot: optionalString(host.projectRoot, 'snapshot.host.projectRoot'),
    },
    locator: optionalString(s.locator, 'snapshot.locator'),
    metadata: optionalRecord(s.metadata, 'snapshot.metadata'),
    model: optionalString(s.model, 'snapshot.model'),
    provenance: optionalRecord(s.provenance, 'snapshot.provenance'),
    rawContent: requireString(s.rawContent, 'snapshot.rawContent'),
    status:
      s.status === undefined || s.status === null
        ? undefined
        : coerceEnum(s.status, ['active', 'completed'] as const, 'snapshot.status'),
    title: optionalString(s.title, 'snapshot.title'),
  };
}

function coerceTrustLevel(value: unknown): TrustLevel {
  if (value === 'raw' || value === 'trusted') {
    return value;
  }
  throw new HttpError(400, 'bad_request', "envelope.trustLevel must be 'raw' or 'trusted'");
}

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- membership checked against the literal set
    return value as T;
  }
  throw new HttpError(400, 'bad_request', `${label} must be one of ${allowed.join(', ')}`);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a non-array object above
  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asObject(value);
  if (record === undefined) {
    throw new HttpError(400, 'bad_request', `${label} must be an object`);
  }
  return record;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireRecord(value, label);
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
