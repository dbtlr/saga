import { describe, expect, it } from 'vitest';

import { SagaApiClient, SagaApiError } from './client.js';

type Capture = {
  init: RequestInit | undefined;
  url: string;
};

function stubFetch(responder: (url: string, init: RequestInit | undefined) => Response): {
  calls: Capture[];
  fetch: typeof fetch;
} {
  const calls: Capture[] = [];
  // SagaApiClient always calls fetch with a fully-built string URL, so the stub
  // only needs to accept a string.
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ init, url: input });
    return responder(input, init);
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe('request construction', () => {
  it('builds GET /v1/sessions with workspace scope and paging query params', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse([]));
    const client = new SagaApiClient({ baseUrl: 'http://127.0.0.1:4766', fetch });

    await client.listSessions({
      activeOnly: true,
      harness: 'codex',
      limit: 5,
      workspaceId: 'ws-1',
    });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/sessions');
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('harness')).toBe('codex');
    expect(url.searchParams.get('activeOnly')).toBe('true');
  });

  it('omits undefined query params rather than sending "undefined"', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse([]));
    const client = new SagaApiClient({ baseUrl: 'http://127.0.0.1:4766', fetch });

    await client.listSessions({ workspaceId: 'ws-1' });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('harness')).toBe(false);
    expect(url.searchParams.has('activeOnly')).toBe(false);
  });

  it('normalizes a trailing slash on the base url and encodes path ids', async () => {
    const { calls, fetch } = stubFetch(() => jsonResponse({}));
    const client = new SagaApiClient({ baseUrl: 'http://127.0.0.1:4766/', fetch });

    await client.getSessionContext('seg/with space', { workspaceId: 'ws-1' });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/sessions/seg%2Fwith%20space/context');
    expect(calls[0]?.url.startsWith('http://127.0.0.1:4766/v1/')).toBe(true);
  });

  it('posts the recall body as JSON with a content-type header', async () => {
    const { calls, fetch } = stubFetch(() =>
      jsonResponse({
        intervals: [],
        matchCount: 0,
        query: 'hello',
        searchedAt: '2026-01-01T00:00:00.000Z',
        sessions: [],
        workspaceId: 'ws-1',
      }),
    );
    const client = new SagaApiClient({ baseUrl: 'http://127.0.0.1:4766', fetch });

    await client.recall({ query: 'hello', workspaceId: 'ws-1' });

    expect(calls[0]?.init?.method).toBe('POST');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse((calls[0]?.init?.body as string) ?? 'null')).toStrictEqual({
      query: 'hello',
      workspaceId: 'ws-1',
    });
  });

  it('sends an Authorization: Bearer header only when a token is configured', async () => {
    const withToken = stubFetch(() => jsonResponse({}));
    const authed = new SagaApiClient({
      authToken: 'secret-token',
      baseUrl: 'http://127.0.0.1:4766',
      fetch: withToken.fetch,
    });
    await authed.info();
    expect(new Headers(withToken.calls[0]?.init?.headers).get('authorization')).toBe(
      'Bearer secret-token',
    );

    const withoutToken = stubFetch(() => jsonResponse({}));
    const anon = new SagaApiClient({
      baseUrl: 'http://127.0.0.1:4766',
      fetch: withoutToken.fetch,
    });
    await anon.info();
    expect(new Headers(withoutToken.calls[0]?.init?.headers).has('authorization')).toBe(false);
  });
});

describe('error mapping', () => {
  it('maps a structured { error: { code, message } } body to SagaApiError', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ error: { code: 'not_found', message: 'session not found' } }, 404),
    );
    const client = new SagaApiClient({ baseUrl: 'http://127.0.0.1:4766', fetch });

    const error = await client
      .getSession('missing', { workspaceId: 'ws-1' })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(SagaApiError);
    expect((error as SagaApiError).status).toBe(404);
    expect((error as SagaApiError).code).toBe('not_found');
    expect((error as SagaApiError).message).toBe('session not found');
  });

  it('falls back to status-derived code/message on a non-JSON error body', async () => {
    const { fetch } = stubFetch(
      () => new Response('gateway boom', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = new SagaApiClient({ baseUrl: 'http://127.0.0.1:4766', fetch });

    const error = await client.listEvents({ workspaceId: 'ws-1' }).catch((cause) => cause);
    expect(error).toBeInstanceOf(SagaApiError);
    expect((error as SagaApiError).status).toBe(502);
    expect((error as SagaApiError).code).toBe('http_502');
    expect((error as SagaApiError).message).toBe('Bad Gateway');
  });
});
