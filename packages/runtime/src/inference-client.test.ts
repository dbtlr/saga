import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Either, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  InferenceAuthExpired,
  InferenceAuthUnavailable,
  InferenceMalformedResponse,
  InferenceNotConfigured,
  InferencePolicyDisabled,
  InferenceTransportError,
  makeCodexSubscriptionInferenceClient,
  makeOpenAiApiInferenceClient,
  resolveInferenceClient,
} from './inference-client.js';
import type { StructuredGenerationRequest } from './inference-client.js';

const TestSchema = Schema.Struct({ count: Schema.Number, title: Schema.String });

function request(): StructuredGenerationRequest<
  { count: number; title: string },
  { count: number; title: string }
> {
  return {
    input: 'Summarize the session.',
    instructions: 'Extract a title and a count.',
    schema: TestSchema,
  };
}

function runEither<A, E>(effect: Effect.Effect<A, E>): Promise<Either.Either<A, E>> {
  return Effect.runPromise(Effect.either(effect));
}

function expectLeft<A, E>(result: Either.Either<A, E>): E {
  if (Either.isRight(result)) {
    throw new Error('expected a failure but got a success');
  }
  return result.left;
}

function expectRight<A, E>(result: Either.Either<A, E>): A {
  if (Either.isLeft(result)) {
    throw new Error('expected a success but got a failure');
  }
  return result.right;
}

type CapturedCall = { init: RequestInit | undefined; url: string };

function requestUrl(url: Parameters<typeof fetch>[0]): string {
  // Every transport in this module fetches with a string URL, so a non-string here is a bug.
  if (typeof url !== 'string') {
    throw new Error('expected a string request URL');
  }
  return url;
}

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new Error('expected a serialized JSON request body');
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function openAiResponse(payload: unknown): Response {
  return Response.json({
    output: [
      { content: [{ text: JSON.stringify(payload), type: 'output_text' }], type: 'message' },
    ],
  });
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const fetch401: typeof fetch = async () => new Response('', { status: 401 });
const fetchNoOutputText: typeof fetch = async () => Response.json({ output: [] });
const fetchSchemaInvalid: typeof fetch = async () => openAiResponse({ count: 'not-a-number' });
const fetchEmptyStream: typeof fetch = async () =>
  sseResponse(['data: {"type":"response.completed"}', '', 'data: [DONE]', ''].join('\n'));
const neverFetch: typeof fetch = async () => {
  throw new Error('fetch should not be called during resolution');
};
// A fetch that only settles when its abort signal fires, so a tiny timeout override drives it.
const neverResolvingFetch: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });
const fetchRefusal: typeof fetch = async () =>
  Response.json({
    output: [
      {
        content: [{ refusal: 'I will not do that secret thing', type: 'refusal' }],
        type: 'message',
      },
    ],
  });
const fetchIncomplete: typeof fetch = async () =>
  Response.json({ incomplete_details: { reason: 'max_output_tokens' }, status: 'incomplete' });

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'saga-inference-client-'));
}

function writeSagaConfig(home: string, contents: string): void {
  mkdirSync(join(home, '.saga'), { recursive: true });
  writeFileSync(join(home, '.saga', 'config.json'), contents);
}

describe('makeOpenAiApiInferenceClient', () => {
  it('sends a Responses API structured request and returns the validated object', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ init, url: requestUrl(url) });
      return openAiResponse({ count: 3, title: 'Session' });
    };
    const client = makeOpenAiApiInferenceClient({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example/v1',
      fetch: fetchImpl,
      model: 'gpt-4o-mini',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(result).toStrictEqual(Either.right({ count: 3, title: 'Session' }));
    expect(calls[0]?.url).toBe('https://api.example/v1/responses');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    });
    const body = parseRequestBody(calls[0]?.init);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.text).toMatchObject({ format: { type: 'json_schema' } });
  });

  it('does not send strict:true and round-trips a schema with optional fields', async () => {
    const OptionalSchema = Schema.Struct({
      count: Schema.Number,
      note: Schema.optional(Schema.String),
    });
    const calls: CapturedCall[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ init, url: requestUrl(url) });
      // The model omits the optional field entirely; strict mode would have 400'd the request.
      return openAiResponse({ count: 4 });
    };
    const client = makeOpenAiApiInferenceClient({ apiKey: 'sk', fetch: fetchImpl, model: 'm' });

    const result = await runEither(
      client.generateStructured({
        input: 'x',
        instructions: 'y',
        schema: OptionalSchema,
      }),
    );

    expect(expectRight(result)).toStrictEqual({ count: 4 });
    const format = parseRequestBody(calls[0]?.init).text as { format: Record<string, unknown> };
    expect(format.format.strict).toBeUndefined();
  });

  it('treats an empty/whitespace baseUrl as absent and uses the default OpenAI URL', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ init, url: requestUrl(url) });
      return openAiResponse({ count: 1, title: 'x' });
    };
    const client = makeOpenAiApiInferenceClient({
      apiKey: 'sk',
      baseUrl: '   ',
      fetch: fetchImpl,
      model: 'm',
    });

    await runEither(client.generateStructured(request()));

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
  });

  it('maps a timed-out request to InferenceTransportError', async () => {
    const client = makeOpenAiApiInferenceClient({
      apiKey: 'sk',
      fetch: neverResolvingFetch,
      model: 'm',
      timeoutMs: 5,
    });

    const result = await runEither(client.generateStructured(request()));

    const error = expectLeft(result);
    expect(error).toBeInstanceOf(InferenceTransportError);
    expect((error as InferenceTransportError).detail).toContain('timed out');
  });

  it('maps a refusal content part to a generic InferenceMalformedResponse', async () => {
    const client = makeOpenAiApiInferenceClient({ apiKey: 'sk', fetch: fetchRefusal, model: 'm' });

    const result = await runEither(client.generateStructured(request()));

    const error = expectLeft(result);
    expect(error).toBeInstanceOf(InferenceMalformedResponse);
    expect((error as InferenceMalformedResponse).detail).toBe('model refused the request');
    expect((error as InferenceMalformedResponse).detail).not.toContain('secret');
  });

  it('maps a top-level incomplete response to InferenceTransportError', async () => {
    const client = makeOpenAiApiInferenceClient({
      apiKey: 'sk',
      fetch: fetchIncomplete,
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    const error = expectLeft(result);
    expect(error).toBeInstanceOf(InferenceTransportError);
    expect((error as InferenceTransportError).detail).toContain('truncated');
  });

  it('maps HTTP 401 to InferenceAuthExpired', async () => {
    const client = makeOpenAiApiInferenceClient({ apiKey: 'sk', fetch: fetch401, model: 'm' });

    const result = await runEither(client.generateStructured(request()));

    expect(expectLeft(result)).toBeInstanceOf(InferenceAuthExpired);
  });

  it('maps a response without output_text to InferenceMalformedResponse', async () => {
    const client = makeOpenAiApiInferenceClient({
      apiKey: 'sk',
      fetch: fetchNoOutputText,
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(expectLeft(result)).toBeInstanceOf(InferenceMalformedResponse);
  });

  it('maps schema-invalid output to InferenceMalformedResponse', async () => {
    const client = makeOpenAiApiInferenceClient({
      apiKey: 'sk',
      fetch: fetchSchemaInvalid,
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(expectLeft(result)).toBeInstanceOf(InferenceMalformedResponse);
  });
});

describe('makeCodexSubscriptionInferenceClient', () => {
  const sseStream = [
    'event: response.created',
    'data: {"type":"response.created"}',
    '',
    String.raw`data: {"type":"response.output_text.delta","delta":"{\"title\":"}`,
    '',
    String.raw`data: {"type":"response.output_text.delta","delta":"\"Session\",\"count\":7}"}`,
    '',
    'data: {"type":"response.completed"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  it('assembles SSE output_text deltas into the validated object', async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ init, url: requestUrl(url) });
      return sseResponse(sseStream);
    };
    const client = makeCodexSubscriptionInferenceClient({
      accessToken: 'access-123',
      accountId: 'acct-abc',
      baseUrl: 'https://chatgpt.example/backend-api/codex',
      fetch: fetchImpl,
      model: 'gpt-4o-mini',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(result).toStrictEqual(Either.right({ count: 7, title: 'Session' }));
    expect(calls[0]?.url).toBe('https://chatgpt.example/backend-api/codex/responses');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer access-123',
      'chatgpt-account-id': 'acct-abc',
    });
    const body = parseRequestBody(calls[0]?.init);
    expect(body.stream).toBe(true);
    expect(body.instructions).toContain('JSON Schema');
  });

  it('maps HTTP 401 to InferenceAuthExpired', async () => {
    const client = makeCodexSubscriptionInferenceClient({
      accessToken: 'a',
      accountId: 'b',
      fetch: fetch401,
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(expectLeft(result)).toBeInstanceOf(InferenceAuthExpired);
  });

  it('maps a stream with no output_text deltas to InferenceMalformedResponse', async () => {
    const client = makeCodexSubscriptionInferenceClient({
      accessToken: 'a',
      accountId: 'b',
      fetch: fetchEmptyStream,
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(expectLeft(result)).toBeInstanceOf(InferenceMalformedResponse);
  });

  it('joins the multiple data: lines of a single event before parsing', async () => {
    const stream = [
      'data: {"type":"response.output_text.delta","delta":',
      String.raw`data: "{\"title\":\"S\",\"count\":1}"}`,
      '',
      'data: {"type":"response.completed"}',
      '',
    ].join('\n');
    const client = makeCodexSubscriptionInferenceClient({
      accessToken: 'a',
      accountId: 'b',
      fetch: async () => sseResponse(stream),
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(expectRight(result)).toStrictEqual({ count: 1, title: 'S' });
  });

  it('assembles output from a CR-terminated stream', async () => {
    const stream = [
      String.raw`data: {"type":"response.output_text.delta","delta":"{\"title\":\"S\",\"count\":2}"}`,
      '',
      'data: {"type":"response.completed"}',
      '',
      '',
    ].join('\r');
    const client = makeCodexSubscriptionInferenceClient({
      accessToken: 'a',
      accountId: 'b',
      fetch: async () => sseResponse(stream),
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(expectRight(result)).toStrictEqual({ count: 2, title: 'S' });
  });

  it('maps a response.failed terminal event to InferenceTransportError', async () => {
    const stream = [
      'data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}',
      '',
    ].join('\n');
    const client = makeCodexSubscriptionInferenceClient({
      accessToken: 'a',
      accountId: 'b',
      fetch: async () => sseResponse(stream),
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    expect(expectLeft(result)).toBeInstanceOf(InferenceTransportError);
  });

  it('fails a stream that ends without a terminal event instead of succeeding silently', async () => {
    const stream = ['data: {"type":"response.output_text.delta","delta":"partial"}', ''].join('\n');
    const client = makeCodexSubscriptionInferenceClient({
      accessToken: 'a',
      accountId: 'b',
      fetch: async () => sseResponse(stream),
      model: 'm',
    });

    const result = await runEither(client.generateStructured(request()));

    const error = expectLeft(result);
    expect(error).toBeInstanceOf(InferenceTransportError);
    expect((error as InferenceTransportError).detail).toContain('without a terminal event');
  });
});

describe('resolveInferenceClient', () => {
  it('fails with InferenceNotConfigured when no inference section exists', async () => {
    const home = tempHome();

    const result = await runEither(
      resolveInferenceClient({ env: {}, fetch: neverFetch, homeDir: home }),
    );

    expect(expectLeft(result)).toBeInstanceOf(InferenceNotConfigured);
  });

  it('fails with InferencePolicyDisabled when inference is explicitly disabled', async () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ inference: { remote: 'disabled' } }));

    const result = await runEither(
      resolveInferenceClient({ env: {}, fetch: neverFetch, homeDir: home }),
    );

    expect(expectLeft(result)).toBeInstanceOf(InferencePolicyDisabled);
  });

  it('fails with InferenceAuthUnavailable when the api-key transport has no key', async () => {
    const home = tempHome();
    writeSagaConfig(
      home,
      JSON.stringify({ inference: { provider: 'openai-api', remote: 'enabled' } }),
    );

    const result = await runEither(
      resolveInferenceClient({ env: {}, fetch: neverFetch, homeDir: home }),
    );

    expect(expectLeft(result)).toBeInstanceOf(InferenceAuthUnavailable);
  });

  it('resolves the openai-api transport when enabled with a key', async () => {
    const home = tempHome();
    writeSagaConfig(
      home,
      JSON.stringify({ inference: { provider: 'openai-api', remote: 'enabled' } }),
    );

    const result = await runEither(
      resolveInferenceClient({
        env: { OPENAI_API_KEY: 'sk-env' },
        fetch: neverFetch,
        homeDir: home,
      }),
    );

    expect(expectRight(result).provider).toBe('openai-api');
  });

  it('resolves the codex-subscription transport when enabled with ChatGPT auth', async () => {
    const home = tempHome();
    writeSagaConfig(
      home,
      JSON.stringify({ inference: { provider: 'codex-subscription', remote: 'enabled' } }),
    );
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'access-123', account_id: 'acct-abc' },
      }),
    );

    const result = await runEither(
      resolveInferenceClient({ env: {}, fetch: neverFetch, homeDir: home }),
    );

    expect(expectRight(result).provider).toBe('codex-subscription');
  });
});
