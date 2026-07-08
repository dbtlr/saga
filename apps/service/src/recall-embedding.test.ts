import { describe, expect, it } from 'vitest';

import { resolveServiceRecallEmbedding } from './recall-embedding.js';

// SGA-253: the service resolver is a port of apps/cli's resolveRecallSearchEmbedding.
// The service's integration tests inject a fake resolver, so this unit test is the
// one that exercises the real ADR-0032 gate branches: it must never egress the query
// text unless installation policy enables remote embeddings AND a credential is
// available, and it must degrade (not throw) on any failure. Credentials/policy are
// injected via readFile/env so nothing touches the real environment.
describe('resolveServiceRecallEmbedding', () => {
  const availableAuthOptions = {
    env: {},
    homeDir: '/tmp/saga-service-recall-available-codex',
    readFile: () => JSON.stringify({ OPENAI_API_KEY: 'sk-service-recall-secret' }),
  };
  const disabledPolicyOptions = {
    env: {},
    homeDir: '/tmp/saga-service-recall-disabled-home',
    readFile: () => JSON.stringify({ embeddings: { remote: 'disabled' } }),
  };
  const enabledPolicyOptions = {
    env: {},
    homeDir: '/tmp/saga-service-recall-enabled-home',
    readFile: () => JSON.stringify({ embeddings: { remote: 'enabled' } }),
  };

  it('never calls the remote provider when remote embeddings are disabled by policy', async () => {
    const fetchSpy = recordingFetch();

    const resolved = await resolveServiceRecallEmbedding('vector recall', {
      // Valid credentials are present; only policy should keep the query text local.
      authOptions: availableAuthOptions,
      fetchImpl: fetchSpy.impl,
      policyOptions: disabledPolicyOptions,
    });

    expect(resolved.queryEmbedding).toBeUndefined();
    expect(resolved.posture).toMatchObject({ mode: 'lexical', reason: 'disabled-by-policy' });
    expect(fetchSpy.calls).toBe(0);
  });

  it('degrades without a remote call when credentials are unavailable', async () => {
    const fetchSpy = recordingFetch();

    const resolved = await resolveServiceRecallEmbedding('vector recall', {
      authOptions: {
        env: {},
        homeDir: '/tmp/saga-service-recall-missing-codex',
        readFile: () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      },
      fetchImpl: fetchSpy.impl,
      policyOptions: enabledPolicyOptions,
    });

    expect(resolved.queryEmbedding).toBeUndefined();
    expect(resolved.posture.mode).toBe('degraded');
    expect(fetchSpy.calls).toBe(0);
  });

  it('embeds the query when policy enabled and credentials available', async () => {
    const fetchSpy = recordingFetch();

    const resolved = await resolveServiceRecallEmbedding('vector recall', {
      authOptions: availableAuthOptions,
      fetchImpl: fetchSpy.impl,
      policyOptions: enabledPolicyOptions,
    });

    expect(fetchSpy.calls).toBe(1);
    expect(resolved.posture).toStrictEqual({ mode: 'vector' });
    expect(resolved.queryEmbedding).toMatchObject({ provider: 'openai', vector: [0.1, 0.2, 0.3] });
  });

  it('degrades with embedding-error (and no secret leak) when the embedding request fails', async () => {
    const failingFetch = (async () =>
      Response.json({ error: 'boom' }, { status: 500 })) as unknown as typeof fetch;

    const resolved = await resolveServiceRecallEmbedding('vector recall', {
      authOptions: availableAuthOptions,
      fetchImpl: failingFetch,
      policyOptions: enabledPolicyOptions,
    });

    expect(resolved.queryEmbedding).toBeUndefined();
    expect(resolved.posture).toMatchObject({ mode: 'degraded', reason: 'embedding-error' });
    expect(resolved.posture.detail).not.toContain('sk-service-recall-secret');
  });
});

function recordingFetch(): { calls: number; impl: typeof fetch } {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls += 1;
    return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }, { status: 200 });
  }) as unknown as typeof fetch;
  return {
    get calls() {
      return state.calls;
    },
    impl,
  };
}
