import type { DatabaseService } from '@saga/db';
import { describe, expect, it } from 'vitest';

import { createSagaApp } from './app.js';
import type { SagaAppDependencies } from './app.js';

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
});
