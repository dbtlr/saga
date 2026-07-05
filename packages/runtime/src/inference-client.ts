import { Data, Effect, JSONSchema, Schema } from 'effect';

import { resolveCodexInferenceAuth } from './codex-inference-auth.js';
import { resolveInferenceApiKey } from './inference-credential.js';
import { resolveInferenceConfig } from './inference-policy.js';

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
// The Codex CLI's ChatGPT backend, the Responses API surface for subscription auth.
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

// Errors known at resolution time (before any request is made). The consuming job can
// discriminate a deliberate opt-out from a misconfiguration.
export class InferencePolicyDisabled extends Data.TaggedError('InferencePolicyDisabled')<{
  readonly detail: string;
}> {}

export class InferenceNotConfigured extends Data.TaggedError('InferenceNotConfigured')<{
  readonly detail: string;
}> {}

export class InferenceAuthUnavailable extends Data.TaggedError('InferenceAuthUnavailable')<{
  readonly detail: string;
  readonly reason: string;
}> {}

// Errors raised at call time. AuthExpired (HTTP 401) is the signal the consolidation job
// treats as a stall; it must be discriminable from every other call-time failure.
export class InferenceAuthExpired extends Data.TaggedError('InferenceAuthExpired')<{
  readonly detail: string;
}> {}

export class InferenceTransportError extends Data.TaggedError('InferenceTransportError')<{
  readonly detail: string;
  readonly status?: number;
}> {}

export class InferenceMalformedResponse extends Data.TaggedError('InferenceMalformedResponse')<{
  readonly detail: string;
}> {}

export type InferenceResolutionError =
  | InferencePolicyDisabled
  | InferenceNotConfigured
  | InferenceAuthUnavailable;

export type InferenceGenerationError =
  | InferenceAuthExpired
  | InferenceTransportError
  | InferenceMalformedResponse;

export type InferenceError = InferenceResolutionError | InferenceGenerationError;

export type StructuredGenerationRequest<A, I> = {
  input: string;
  instructions: string;
  schema: Schema.Schema<A, I>;
  schemaName?: string | undefined;
};

export type InferenceClient = {
  generateStructured: <A, I>(
    request: StructuredGenerationRequest<A, I>,
  ) => Effect.Effect<A, InferenceGenerationError>;
  provider: 'openai-api' | 'codex-subscription';
};

export type OpenAiApiInferenceClientOptions = {
  apiKey: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  model: string;
};

export type CodexSubscriptionInferenceClientOptions = {
  accessToken: string;
  accountId: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  model: string;
};

// The union of the config, credential, and Codex-auth resolution inputs (all share the same
// env/homeDir/readFile shape) plus transport wiring for tests and base-URL overrides.
export type InferenceClientResolutionOptions = {
  baseUrls?: { codex?: string; openaiApi?: string };
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  homeDir?: string;
  readFile?: (path: string) => string;
};

// Resolve the configured transport into a ready client, or fail with a resolution-time error.
// Policy and credential/auth are checked up front; the returned client's generateStructured
// only ever fails with call-time errors, so the caller can catch a 401 stall cleanly.
export function resolveInferenceClient(
  options: InferenceClientResolutionOptions = {},
): Effect.Effect<InferenceClient, InferenceResolutionError> {
  return Effect.suspend((): Effect.Effect<InferenceClient, InferenceResolutionError> => {
    const config = resolveInferenceConfig(options);
    if (config.policy === 'not-configured') {
      return Effect.fail(new InferenceNotConfigured({ detail: config.detail }));
    }
    if (config.policy === 'disabled') {
      return Effect.fail(new InferencePolicyDisabled({ detail: config.detail }));
    }

    if (config.provider === 'openai-api') {
      const credential = resolveInferenceApiKey(options);
      if (credential.status === 'unavailable') {
        return Effect.fail(
          new InferenceAuthUnavailable({
            detail: credential.detail,
            reason: 'openai-api-key-unavailable',
          }),
        );
      }
      return Effect.succeed(
        makeOpenAiApiInferenceClient({
          apiKey: credential.apiKey,
          baseUrl: options.baseUrls?.openaiApi,
          fetch: options.fetch,
          model: config.model,
        }),
      );
    }

    const auth = resolveCodexInferenceAuth(options);
    if (auth.status === 'unavailable') {
      return Effect.fail(
        new InferenceAuthUnavailable({ detail: auth.detail, reason: auth.reason }),
      );
    }
    return Effect.succeed(
      makeCodexSubscriptionInferenceClient({
        accessToken: auth.accessToken,
        accountId: auth.accountId,
        baseUrl: options.baseUrls?.codex,
        fetch: options.fetch,
        model: config.model,
      }),
    );
  });
}

// Transport A: the standard OpenAI Responses API with native structured output. The JSON
// schema is derived from the Effect Schema and sent as text.format json_schema (strict); the
// non-streaming response's output_text is parsed and re-validated against the same schema.
export function makeOpenAiApiInferenceClient(
  options: OpenAiApiInferenceClientOptions,
): InferenceClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? OPENAI_API_BASE_URL;

  return {
    provider: 'openai-api',
    generateStructured: (request) =>
      Effect.tryPromise({
        try: () => requestOpenAiApi(fetchImpl, baseUrl, options, request),
        catch: toGenerationError,
      }).pipe(Effect.flatMap((text) => decodeStructured(request.schema, text))),
  };
}

// Transport B: the Codex ChatGPT backend (Responses API surface), streaming-only. This
// backend does not honor the json_schema response format, so structured output is requested
// via schema-in-prompt: the derived JSON schema is embedded in the instructions and the SSE
// output_text deltas are concatenated, then parsed and validated against the Effect Schema.
export function makeCodexSubscriptionInferenceClient(
  options: CodexSubscriptionInferenceClientOptions,
): InferenceClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? CODEX_BASE_URL;

  return {
    provider: 'codex-subscription',
    generateStructured: (request) =>
      Effect.tryPromise({
        try: () => requestCodex(fetchImpl, baseUrl, options, request),
        catch: toGenerationError,
      }).pipe(Effect.flatMap((text) => decodeStructured(request.schema, text))),
  };
}

async function requestOpenAiApi<A, I>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: OpenAiApiInferenceClientOptions,
  request: StructuredGenerationRequest<A, I>,
): Promise<string> {
  const schema = toResponseJsonSchema(request.schema);
  const response = await fetchImpl(`${baseUrl}/responses`, {
    body: JSON.stringify({
      input: request.input,
      instructions: request.instructions,
      model: options.model,
      text: {
        format: {
          name: request.schemaName ?? 'structured_output',
          schema,
          strict: true,
          type: 'json_schema',
        },
      },
    }),
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  assertOkResponse('openai-api', response);
  const body = await readJsonBody(response);
  return extractResponsesOutputText(body);
}

async function requestCodex<A, I>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: CodexSubscriptionInferenceClientOptions,
  request: StructuredGenerationRequest<A, I>,
): Promise<string> {
  const schema = toResponseJsonSchema(request.schema);
  const instructions = `${request.instructions}\n\nRespond with ONLY a single JSON object that validates against this JSON Schema. Do not include prose, explanation, or code fences.\nJSON Schema:\n${JSON.stringify(schema)}`;
  const response = await fetchImpl(`${baseUrl}/responses`, {
    body: JSON.stringify({
      input: request.input,
      instructions,
      model: options.model,
      stream: true,
    }),
    headers: {
      accept: 'text/event-stream',
      authorization: `Bearer ${options.accessToken}`,
      'chatgpt-account-id': options.accountId,
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  assertOkResponse('codex-subscription', response);
  const text = await assembleSseOutputText(response);
  if (text.trim() === '') {
    throw new InferenceMalformedResponse({
      detail: 'codex-subscription stream produced no response.output_text.delta events',
    });
  }
  return text;
}

// Concatenate the delta of every response.output_text.delta SSE event, ignoring other event
// types and the [DONE] sentinel.
async function assembleSseOutputText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    throw new InferenceMalformedResponse({
      detail: 'codex-subscription response had no readable stream body',
    });
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assembled = '';

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      return;
    }
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(payload) as unknown;
    } catch {
      // Ignore keepalives or partial frames that are not valid JSON.
      return;
    }
    if (
      isRecord(event) &&
      event.type === 'response.output_text.delta' &&
      typeof event.delta === 'string'
    ) {
      assembled += event.delta;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    consumeLine(buffer);
  }
  return assembled;
}

function assertOkResponse(provider: string, response: Response): void {
  if (response.status === 401) {
    throw new InferenceAuthExpired({
      detail: `${provider} request rejected with HTTP 401 (authentication failed)`,
    });
  }
  if (!response.ok) {
    throw new InferenceTransportError({
      detail: `${provider} request failed with HTTP ${String(response.status)} (${httpFailureCategory(response.status)})`,
      status: response.status,
    });
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new InferenceMalformedResponse({ detail: 'inference response body was not valid JSON' });
  }
}

// Extract the assistant text from a Responses API body: the convenience output_text, or the
// concatenation of output[].content[] entries of type output_text.
function extractResponsesOutputText(body: unknown): string {
  if (!isRecord(body)) {
    throw new InferenceMalformedResponse({ detail: 'inference response was not an object' });
  }
  if (typeof body.output_text === 'string' && body.output_text !== '') {
    return body.output_text;
  }
  const output = body.output;
  if (Array.isArray(output)) {
    let assembled = '';
    for (const item of output) {
      if (!isRecord(item) || !Array.isArray(item.content)) {
        continue;
      }
      for (const part of item.content) {
        if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
          assembled += part.text;
        }
      }
    }
    if (assembled !== '') {
      return assembled;
    }
  }
  throw new InferenceMalformedResponse({
    detail: 'inference response contained no output_text content',
  });
}

function decodeStructured<A, I>(
  schema: Schema.Schema<A, I>,
  text: string,
): Effect.Effect<A, InferenceMalformedResponse> {
  return Effect.try({
    catch: () => new InferenceMalformedResponse({ detail: 'inference output was not valid JSON' }),
    try: () => JSON.parse(stripCodeFence(text)) as unknown,
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknown(schema)(json).pipe(
        Effect.mapError(
          () =>
            new InferenceMalformedResponse({
              detail: 'inference output did not match the requested schema',
            }),
        ),
      ),
    ),
  );
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

// Derive a strict JSON Schema for the Responses API / schema-in-prompt. The $schema meta key
// is dropped so the schema object embeds cleanly into the request.
function toResponseJsonSchema<A, I>(schema: Schema.Schema<A, I>): Record<string, unknown> {
  const generated: Record<string, unknown> = { ...JSONSchema.make(schema) };
  delete generated.$schema;
  return generated;
}

function toGenerationError(error: unknown): InferenceGenerationError {
  if (
    error instanceof InferenceAuthExpired ||
    error instanceof InferenceTransportError ||
    error instanceof InferenceMalformedResponse
  ) {
    return error;
  }
  return new InferenceTransportError({
    detail: `inference request failed: ${error instanceof Error ? error.message : String(error)}`,
  });
}

function httpFailureCategory(status: number): string {
  switch (status) {
    case 400:
    case 422: {
      return 'invalid request';
    }
    case 403: {
      return 'authorization failed';
    }
    case 408: {
      return 'request timeout';
    }
    case 409: {
      return 'request conflict';
    }
    case 429: {
      return 'rate limited';
    }
    default: {
      if (status >= 400 && status < 500) {
        return 'client error';
      }
      if (status >= 500 && status < 600) {
        return 'server error';
      }
      return 'unexpected status';
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
