import type { DatabaseService } from '@saga/db';
import { describe, expect, it, vi } from 'vitest';

import { createSagaApp } from './app.js';
import type { SagaAppDependencies } from './app.js';

// Hono's app.request defaults the Host header to `localhost`, which is in the
// loopback allow-set, so the DNS-rebinding guard is transparent to these tests.

function makeApp(overrides: Partial<SagaAppDependencies> = {}) {
  return createSagaApp({
    getDatabase: () => undefined,
    jobStatus: () => [],
    startedAt: Date.now(),
    version: '9.9.9',
    ...overrides,
  });
}

// A non-null stand-in so requireDatabase passes and request validation runs
// before any db function would be invoked. Its methods are never called in these
// unit tests (validation short-circuits first).
const stubDatabase = {} as DatabaseService;

async function errorBody(
  response: Response,
): Promise<{ error: { code: string; message: string } }> {
  return (await response.json()) as { error: { code: string; message: string } };
}

describe('createSagaApp /health', () => {
  it('returns the byte-compatible health payload with a bare application/json type', async () => {
    const app = makeApp({
      jobStatus: () => [
        {
          consecutiveFailures: 0,
          lastOutcome: 'succeeded',
          lastRunAt: '2026-01-01T00:00:00.000Z',
          name: 'heartbeat',
        } as never,
      ],
    });

    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = await response.json();
    expect(body).toMatchObject({ ok: true, service: 'saga' });
    expect(Object.keys(body as object)).toStrictEqual(['jobs', 'ok', 'service', 'uptimeSeconds']);
  });
});

describe('createSagaApp error shape', () => {
  it('renders an unknown route as { error: { code, message } } with 404', async () => {
    const response = await makeApp().request('/no-such-route');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { code: 'not_found', message: 'no route for /no-such-route' },
    });
  });

  it('returns 503 unavailable when the database is not yet ready', async () => {
    const response = await makeApp().request('/v1/sessions?workspaceId=ws-1');
    expect(response.status).toBe(503);
    expect((await errorBody(response)).error.code).toBe('unavailable');
  });

  it('returns 400 bad_request when a required workspaceId is missing', async () => {
    const response = await makeApp({ getDatabase: () => stubDatabase }).request('/v1/sessions');
    expect(response.status).toBe(400);
    const body = await errorBody(response);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('workspaceId');
  });

  it('rejects a non-lexical recall mode with 400 bad_request', async () => {
    const response = await makeApp({ getDatabase: () => stubDatabase }).request('/v1/recall', {
      body: JSON.stringify({ mode: 'vector', query: 'x', workspaceId: 'ws-1' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect((await errorBody(response)).error.message).toContain('lexical');
  });

  it('rejects a non-object recall body with 400 bad_request', async () => {
    const response = await makeApp({ getDatabase: () => stubDatabase }).request('/v1/recall', {
      body: '["not an object"]',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(400);
  });

  it('renders a forced handler defect as a 500 with no stack or driver text', async () => {
    // A getDatabase that throws a non-HttpError propagates out of the handler as a
    // defect; onError must swallow its message and return a static body.
    const leakyCause = new Error('driver failure at /Users/secret/path.ts near stack frame');
    const response = await makeApp({
      getDatabase: () => {
        throw leakyCause;
      },
    }).request('/v1/sessions?workspaceId=ws-1');
    expect(response.status).toBe(500);
    const body = await errorBody(response);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('internal error');
    expect(JSON.stringify(body)).not.toContain('/Users/secret');
    expect(JSON.stringify(body)).not.toContain('driver failure');
  });

  it('rejects an oversized recall body with 413 rather than buffering it into a 400', async () => {
    const oversized = JSON.stringify({
      query: 'x'.repeat(2 * 1024 * 1024),
      workspaceId: 'ws-1',
    });
    const response = await makeApp({ getDatabase: () => stubDatabase }).request('/v1/recall', {
      body: oversized,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(413);
    expect((await errorBody(response)).error.message).toContain('too large');
  });
});

describe('createSagaApp Host allowlist (DNS-rebinding guard)', () => {
  it('rejects a non-loopback Host header with 403 by default', async () => {
    const response = await makeApp({ getDatabase: () => stubDatabase }).request(
      '/v1/sessions?workspaceId=ws-1',
      { headers: { host: 'evil.example.com' } },
    );
    expect(response.status).toBe(403);
    expect((await errorBody(response)).error.code).toBe('forbidden');
  });

  it('permits a non-loopback Host header when the unsafe-bind ack is set', async () => {
    vi.stubEnv('SAGA_SERVICE_UNSAFE_ALLOW_NONLOOPBACK', '1');
    try {
      const response = await makeApp({ getDatabase: () => undefined }).request(
        '/v1/sessions?workspaceId=ws-1',
        { headers: { host: 'saga.internal.example' } },
      );
      // The Host check is skipped, so the request reaches routing and gets the
      // database-not-ready 503 instead of a 403.
      expect(response.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
