import { describe, expect, it } from 'vitest';

import { createOpenAiSessionEmbeddingGenerator } from './session-embeddings.js';

const testProvider = {
  dimensions: 3,
  id: 'openai' as const,
  model: 'test-embedding-model',
};

const firstInput = {
  inputHash: 'sha256:first',
  segmentId: 'segment-first',
  text: 'first segment',
};

const testInputs = [
  firstInput,
  {
    inputHash: 'sha256:second',
    segmentId: 'segment-second',
    text: 'second segment',
  },
];

type OpenAiHttpFailureCase = {
  body: unknown;
  expectedMessage: string;
  leakedDetails: readonly string[];
  name: string;
  status: number;
};

const openAiHttpFailureCases = [
  {
    body: {
      error: {
        message: 'rate limit exceeded for key sk-live-secret-detail',
        type: 'rate_limit_error_with_secret_detail',
      },
    },
    expectedMessage: 'OpenAI embeddings request failed with HTTP 429 (rate limited)',
    leakedDetails: [
      'rate limit exceeded',
      'sk-live-secret-detail',
      'rate_limit_error_with_secret_detail',
    ],
    name: 'rate limit body',
    status: 429,
  },
  {
    body: {
      error: {
        message: 'upstream shard leaked tenant tenant-secret-123',
      },
    },
    expectedMessage: 'OpenAI embeddings request failed with HTTP 503 (server error)',
    leakedDetails: ['upstream shard', 'tenant-secret-123'],
    name: 'server error body',
    status: 503,
  },
] satisfies readonly OpenAiHttpFailureCase[];

type MalformedOpenAiPayloadCase = {
  body: unknown;
  message: string;
  name: string;
};

const malformedOpenAiPayloadCases = [
  {
    body: null,
    message: 'OpenAI embeddings response was not an object',
    name: 'null body',
  },
  {
    body: {},
    message: 'OpenAI embeddings response missing data',
    name: 'missing data',
  },
  {
    body: { data: [null] },
    message: 'OpenAI embeddings response data item 0 was not an object',
    name: 'non-object data item',
  },
  {
    body: { data: [{ embedding: [1, 0, 0] }] },
    message: 'OpenAI embeddings response data item 0 missing valid index',
    name: 'missing index',
  },
  {
    body: { data: [{ embedding: ['bad', 0, 0], index: 0 }] },
    message: 'OpenAI embeddings response embedding at index 0 was malformed',
    name: 'non-numeric embedding',
  },
] satisfies readonly MalformedOpenAiPayloadCase[];

describe('createOpenAiSessionEmbeddingGenerator', () => {
  it('maps out-of-order OpenAI embedding data by response index', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(init ?? {});
      return jsonResponse({
        data: [
          {
            embedding: [0, 1, 0],
            index: 1,
            object: 'embedding',
          },
          {
            embedding: [1, 0, 0],
            index: 0,
            object: 'embedding',
          },
        ],
        object: 'list',
      });
    };

    const generator = createOpenAiSessionEmbeddingGenerator({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      provider: testProvider,
    });

    const outputs = await generator.embedSegments(testInputs);

    expect(outputs).toStrictEqual([
      {
        embedding: [1, 0, 0],
        segmentId: 'segment-first',
      },
      {
        embedding: [0, 1, 0],
        segmentId: 'segment-second',
      },
    ]);
    expect(JSON.parse(requestBodyText(requests[0]))).toStrictEqual({
      dimensions: 3,
      input: ['first segment', 'second segment'],
      model: 'test-embedding-model',
    });
    expect(requests[0]?.headers).toMatchObject({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    });
  });

  it('splits a large batch into bounded sub-requests and preserves order', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(init ?? {});
      const parsed = JSON.parse(requestBodyText(init)) as { input: string[] };
      return jsonResponse({
        data: parsed.input.map((_text, index) => ({
          embedding: [index, 0, 0],
          index,
          object: 'embedding',
        })),
        object: 'list',
      });
    };
    const generator = createOpenAiSessionEmbeddingGenerator({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      provider: testProvider,
    });

    // 300 inputs exceeds the 256-input per-request cap, so the batch splits into 256 + 44.
    const inputs = Array.from({ length: 300 }, (_value, index) => ({
      inputHash: `hash-${String(index)}`,
      segmentId: `segment-${String(index)}`,
      text: `segment text ${String(index)}`,
    }));

    const outputs = await generator.embedSegments(inputs);

    expect(requests).toHaveLength(2);
    expect((JSON.parse(requestBodyText(requests[0])) as { input: string[] }).input).toHaveLength(
      256,
    );
    expect((JSON.parse(requestBodyText(requests[1])) as { input: string[] }).input).toHaveLength(
      44,
    );
    // Every input is covered, in the original order, across the sub-requests.
    expect(outputs.map((output) => output.segmentId)).toStrictEqual(
      inputs.map((input) => input.segmentId),
    );
  });

  it('splits by total characters when inputs are large', async () => {
    const requests: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests.push(init ?? {});
      const parsed = JSON.parse(requestBodyText(init)) as { input: string[] };
      return jsonResponse({
        data: parsed.input.map((_text, index) => ({
          embedding: [index, 0, 0],
          index,
          object: 'embedding',
        })),
        object: 'list',
      });
    };
    const generator = createOpenAiSessionEmbeddingGenerator({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      provider: testProvider,
    });

    // Three 250k-char inputs: the 400k-char per-request cap forces 1 + 1 + 1 (each pair exceeds it).
    const big = 'x'.repeat(250_000);
    const inputs = Array.from({ length: 3 }, (_value, index) => ({
      inputHash: `hash-${String(index)}`,
      segmentId: `segment-${String(index)}`,
      text: big,
    }));

    const outputs = await generator.embedSegments(inputs);

    expect(requests).toHaveLength(3);
    expect(outputs).toHaveLength(3);
  });

  it.each(openAiHttpFailureCases)(
    'rejects OpenAI HTTP/API failures without leaking provider detail: $name',
    async ({ body, expectedMessage, leakedDetails, status }) => {
      const fetchImpl: typeof fetch = async () => jsonResponse(body, { status });
      const generator = createOpenAiSessionEmbeddingGenerator({
        apiKey: 'sk-test',
        fetch: fetchImpl,
        provider: testProvider,
      });

      const message = await rejectedMessage(() => generator.embedSegments([firstInput]));

      expect(message).toBe(expectedMessage);
      for (const leakedDetail of leakedDetails) {
        expect(message).not.toContain(leakedDetail);
      }
    },
  );

  it('categorizes generic OpenAI client failures without reading provider detail', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            message: 'untrusted detail with sk-test-secret',
            type: 'untrusted_error_type',
          },
        },
        { status: 418 },
      );
    const generator = createOpenAiSessionEmbeddingGenerator({
      apiKey: 'sk-test',
      fetch: fetchImpl,
      provider: testProvider,
    });

    const message = await rejectedMessage(() => generator.embedSegments([firstInput]));

    expect(message).toBe('OpenAI embeddings request failed with HTTP 418 (client error)');
    expect(message).not.toContain('untrusted detail');
    expect(message).not.toContain('sk-test-secret');
    expect(message).not.toContain('untrusted_error_type');
  });

  it.each(malformedOpenAiPayloadCases)(
    'rejects malformed OpenAI embedding payloads: $name',
    async ({ body, message }) => {
      const generator = createOpenAiSessionEmbeddingGenerator({
        apiKey: 'sk-test',
        fetch: async () => jsonResponse(body),
        provider: testProvider,
      });

      await expect(generator.embedSegments([firstInput])).rejects.toThrow(message);
    },
  );

  it('rejects invalid JSON OpenAI embedding payloads', async () => {
    const generator = createOpenAiSessionEmbeddingGenerator({
      apiKey: 'sk-test',
      fetch: async () =>
        new Response('{', {
          headers: {
            'content-type': 'application/json',
          },
          status: 200,
        }),
      provider: testProvider,
    });

    await expect(generator.embedSegments([firstInput])).rejects.toThrow(
      'OpenAI embeddings response was not valid JSON',
    );
  });

  it('rejects duplicate response indexes', async () => {
    const generator = createOpenAiSessionEmbeddingGenerator({
      apiKey: 'sk-test',
      fetch: async () =>
        jsonResponse({
          data: [
            { embedding: [1, 0, 0], index: 0 },
            { embedding: [0, 1, 0], index: 0 },
          ],
        }),
      provider: testProvider,
    });

    await expect(generator.embedSegments(testInputs)).rejects.toThrow(
      'OpenAI returned duplicate embedding for input index 0',
    );
  });

  it('rejects out-of-range response indexes', async () => {
    const generator = createOpenAiSessionEmbeddingGenerator({
      apiKey: 'sk-test',
      fetch: async () =>
        jsonResponse({
          data: [{ embedding: [1, 0, 0], index: 1 }],
        }),
      provider: testProvider,
    });

    await expect(generator.embedSegments([firstInput])).rejects.toThrow(
      'OpenAI returned embedding for out-of-range input index 1',
    );
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

function requestBodyText(request: RequestInit | undefined): string {
  if (typeof request?.body !== 'string') {
    throw new Error('expected JSON string request body');
  }
  return request.body;
}

async function rejectedMessage(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error('expected action to reject');
}
