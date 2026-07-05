import { Data, Effect, JSONSchema, Schema } from 'effect';

import { resolveCodexInferenceAuth } from './codex-inference-auth.js';
import type { CodexInferenceAuthUnavailableReason } from './codex-inference-auth.js';
import { resolveInferenceApiKey } from './inference-credential.js';
import { resolveInferenceConfig } from './inference-policy.js';
import type { InferenceProvider } from './inference-policy.js';

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
// The Codex CLI's ChatGPT backend, the Responses API surface for subscription auth.
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

// The json_schema format name is fixed; the Responses API does not use it for anything the
// caller needs to control, and a per-request name is a needless surface.
const STRUCTURED_OUTPUT_NAME = 'structured_output';
// A single shared request deadline. Tests override it via the client options.
const REQUEST_TIMEOUT_MS = 120_000;
// Cap the assembled streaming output so a runaway/abusive stream cannot exhaust memory.
const MAX_STREAM_OUTPUT_BYTES = 10 * 1024 * 1024;

// Errors known at resolution time (before any request is made). The consuming job can
// discriminate a deliberate opt-out from a misconfiguration.
export class InferencePolicyDisabled extends Data.TaggedError('InferencePolicyDisabled')<{
  readonly detail: string;
}> {}

export class InferenceNotConfigured extends Data.TaggedError('InferenceNotConfigured')<{
  readonly detail: string;
}> {}

// The reason a resolution-time auth failure was raised. The codex reasons come straight from
// the Codex-auth reader; the openai-api transport contributes its own key-unavailable reason.
export type InferenceAuthUnavailableReason =
  | CodexInferenceAuthUnavailableReason
  | 'openai-api-key-unavailable';

export class InferenceAuthUnavailable extends Data.TaggedError('InferenceAuthUnavailable')<{
  readonly detail: string;
  readonly reason: InferenceAuthUnavailableReason;
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
};

export type InferenceClient = {
  generateStructured: <A, I>(
    request: StructuredGenerationRequest<A, I>,
  ) => Effect.Effect<A, InferenceGenerationError>;
  provider: InferenceProvider;
};

export type OpenAiApiInferenceClientOptions = {
  apiKey: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  model: string;
  timeoutMs?: number | undefined;
};

export type CodexSubscriptionInferenceClientOptions = {
  accessToken: string;
  accountId: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  model: string;
  timeoutMs?: number | undefined;
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
// schema is derived from the Effect Schema and sent as text.format json_schema; the
// non-streaming response's output_text is parsed and re-validated against the same schema.
export function makeOpenAiApiInferenceClient(
  options: OpenAiApiInferenceClientOptions,
): InferenceClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = resolveBaseUrl(options.baseUrl, OPENAI_API_BASE_URL);

  return {
    provider: 'openai-api',
    generateStructured: (request) =>
      finishStructured(request, (schema) =>
        requestOpenAiApi(fetchImpl, baseUrl, options, request, schema),
      ),
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
  const baseUrl = resolveBaseUrl(options.baseUrl, CODEX_BASE_URL);

  return {
    provider: 'codex-subscription',
    generateStructured: (request) =>
      finishStructured(request, (schema) =>
        requestCodex(fetchImpl, baseUrl, options, request, schema),
      ),
  };
}

// The shared client tail. The JSON schema is derived EAGERLY, outside tryPromise: an
// unsupported schema is a programmer error (Effect.die), not a retryable transport failure,
// and its raw Effect message must never surface. Each transport supplies only the fetch
// closure; everything after — timeout mapping, decode, re-validation — is shared.
function finishStructured<A, I>(
  request: StructuredGenerationRequest<A, I>,
  send: (schema: Record<string, unknown>) => Promise<string>,
): Effect.Effect<A, InferenceGenerationError> {
  return Effect.suspend(() => {
    let schema: Record<string, unknown>;
    try {
      schema = toResponseJsonSchema(request.schema);
    } catch {
      return Effect.die(new Error('schema unsupported for structured output'));
    }
    return Effect.tryPromise({
      catch: toGenerationError,
      try: () => send(schema),
    }).pipe(Effect.flatMap((text) => decodeStructured(request.schema, text)));
  });
}

async function requestOpenAiApi<A, I>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: OpenAiApiInferenceClientOptions,
  request: StructuredGenerationRequest<A, I>,
  schema: Record<string, unknown>,
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/responses`, {
    body: JSON.stringify({
      input: request.input,
      instructions: request.instructions,
      model: options.model,
      text: {
        format: {
          name: STRUCTURED_OUTPUT_NAME,
          schema,
          // No strict:true here: Effect's JSONSchema.make omits optional fields from the
          // `required` array, which OpenAI strict mode rejects with a 400. The schema guides
          // the model; local decodeStructured re-validation is the real enforcement on both
          // transports.
          type: 'json_schema',
        },
      },
    }),
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  await assertOkResponse('openai-api', response);
  const body = await readJsonBody('openai-api', response);
  return extractResponsesOutputText(body);
}

async function requestCodex<A, I>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: CodexSubscriptionInferenceClientOptions,
  request: StructuredGenerationRequest<A, I>,
  schema: Record<string, unknown>,
): Promise<string> {
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
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  await assertOkResponse('codex-subscription', response);
  const text = await assembleSseOutputText(response);
  if (text.trim() === '') {
    throw new InferenceMalformedResponse({
      detail: 'codex-subscription stream produced no output_text',
    });
  }
  return text;
}

type SseTerminal =
  | { kind: 'completed' }
  | { kind: 'incomplete'; reason: string }
  | { kind: 'error'; code: string | undefined; status: number | undefined };

type SseAction =
  | { kind: 'none' }
  | { kind: 'append'; delta: string }
  | { kind: 'terminal'; terminal: SseTerminal };

// A spec-lite SSE parser for the Responses streaming surface. Events are framed by blank
// lines; the (possibly multiple) data: lines of one event join with '\n' before parsing.
// Dispatch is by the JSON event's `type`. Exactly one terminal event is expected: a
// response.completed yields the accumulated text; failure/error and incomplete raise the
// matching call-time error; reaching EOF with no terminal is itself an error (never a silent
// success). Unknown event types are ignored.
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
  let overflow = false;
  let pendingData: string[] = [];
  let terminal: SseTerminal | undefined;

  const flushEvent = (): void => {
    if (pendingData.length === 0) {
      return;
    }
    const payload = pendingData.join('\n');
    pendingData = [];
    if (payload === '[DONE]') {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(payload) as unknown;
    } catch {
      // Ignore keepalives or partial frames that are not valid JSON.
      return;
    }
    const action = classifySseEvent(event);
    if (action.kind === 'append') {
      assembled += action.delta;
      if (assembled.length > MAX_STREAM_OUTPUT_BYTES) {
        overflow = true;
      }
    } else if (action.kind === 'terminal') {
      terminal = action.terminal;
    }
  };

  const handleLine = (line: string): void => {
    if (line === '') {
      flushEvent();
      return;
    }
    if (line.startsWith(':')) {
      return; // SSE comment / heartbeat.
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') {
      return; // Ignore event:, id:, retry: — dispatch is by the JSON `type`.
    }
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    pendingData.push(value);
  };

  const takeLines = (): string[] => {
    const lines: string[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (match === null) {
        break;
      }
      // A lone trailing '\r' may be the first half of a '\r\n' split across chunks; hold it.
      if (match[0] === '\r' && match.index === buffer.length - 1) {
        break;
      }
      lines.push(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    return lines;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.length > 0) {
          handleLine(buffer);
          buffer = '';
        }
        flushEvent();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (const line of takeLines()) {
        handleLine(line);
        if (terminal !== undefined || overflow) {
          break;
        }
      }
      if (terminal !== undefined || overflow) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (overflow) {
    throw new InferenceMalformedResponse({
      detail: 'codex-subscription stream exceeded the maximum response size',
    });
  }
  if (terminal === undefined) {
    throw new InferenceTransportError({
      detail: 'codex-subscription stream ended without a terminal event',
    });
  }
  if (terminal.kind === 'completed') {
    return assembled;
  }
  if (terminal.kind === 'incomplete') {
    throw new InferenceTransportError({
      detail: `codex-subscription stream truncated: ${terminal.reason}`,
    });
  }
  if (terminal.status === 401 || isAuthErrorCode(terminal.code)) {
    throw new InferenceAuthExpired({
      detail: 'codex-subscription stream reported an authentication failure',
    });
  }
  throw new InferenceTransportError({
    detail: `codex-subscription stream failed${terminal.code === undefined ? '' : ` (${terminal.code})`}`,
    ...(terminal.status === undefined ? {} : { status: terminal.status }),
  });
}

function classifySseEvent(event: unknown): SseAction {
  if (!isRecord(event) || typeof event.type !== 'string') {
    return { kind: 'none' };
  }
  switch (event.type) {
    case 'response.output_text.delta': {
      return typeof event.delta === 'string'
        ? { delta: event.delta, kind: 'append' }
        : { kind: 'none' };
    }
    case 'response.completed': {
      return { kind: 'terminal', terminal: { kind: 'completed' } };
    }
    case 'response.incomplete': {
      return {
        kind: 'terminal',
        terminal: { kind: 'incomplete', reason: sseIncompleteReason(event) },
      };
    }
    case 'error':
    case 'response.failed': {
      return { kind: 'terminal', terminal: { kind: 'error', ...extractSseError(event) } };
    }
    default: {
      return { kind: 'none' };
    }
  }
}

function sseIncompleteReason(event: Record<string, unknown>): string {
  const response = isRecord(event.response) ? event.response : event;
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
  return details !== undefined && typeof details.reason === 'string' ? details.reason : 'unknown';
}

function extractSseError(event: Record<string, unknown>): {
  code: string | undefined;
  status: number | undefined;
} {
  const direct = isRecord(event.error) ? event.error : undefined;
  const nested =
    isRecord(event.response) && isRecord(event.response.error) ? event.response.error : undefined;
  const err = direct ?? nested ?? event;
  const code = typeof err.code === 'string' ? err.code : undefined;
  const status = optionalNumber(err.status) ?? optionalNumber(event.status);
  return { code, status };
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isAuthErrorCode(code: string | undefined): boolean {
  if (code === undefined) {
    return false;
  }
  const normalized = code.toLowerCase();
  return normalized === '401' || normalized === 'unauthorized' || normalized === 'invalid_api_key';
}

async function assertOkResponse(provider: string, response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  // The body is unconsumed on this path; release it before throwing.
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401) {
    throw new InferenceAuthExpired({
      detail: `${provider} request rejected with HTTP 401 (authentication failed)`,
    });
  }
  throw new InferenceTransportError({
    detail: `${provider} request failed with HTTP ${String(response.status)}`,
    status: response.status,
  });
}

async function readJsonBody(provider: string, response: Response): Promise<unknown> {
  let raw: string;
  try {
    // Read the body as text first: a network/read failure here is a transport problem, not a
    // malformed-payload problem.
    raw = await response.text();
  } catch {
    throw new InferenceTransportError({ detail: `${provider} response body could not be read` });
  }
  try {
    return JSON.parse(raw) as unknown;
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
  if (body.status === 'incomplete') {
    throw new InferenceTransportError({
      detail: `truncated: ${responseIncompleteReason(body)}`,
    });
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
        if (!isRecord(part)) {
          continue;
        }
        if (part.type === 'refusal') {
          // Never echo the refusal text; the model declined and that is all the caller needs.
          throw new InferenceMalformedResponse({ detail: 'model refused the request' });
        }
        if (part.type === 'output_text' && typeof part.text === 'string') {
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

function responseIncompleteReason(body: Record<string, unknown>): string {
  const details = isRecord(body.incomplete_details) ? body.incomplete_details : undefined;
  return details !== undefined && typeof details.reason === 'string' ? details.reason : 'unknown';
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

// Strip a leading ```json (or bare ```) fence and its trailing ``` by index, not by a
// backtracking regex. A fence is a first line that starts with ``` and a final ``` fence.
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) {
    return trimmed;
  }
  let body = trimmed.slice(firstNewline + 1);
  if (body.endsWith('```')) {
    body = body.slice(0, -3);
  }
  return body.trim();
}

// Derive a JSON Schema for the Responses API / schema-in-prompt. The $schema meta key is
// dropped so the schema object embeds cleanly into the request.
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
  if (isTimeoutError(error)) {
    return new InferenceTransportError({ detail: 'inference request timed out' });
  }
  // Never echo raw error.message: header-construction and similar errors can embed the bearer
  // credential. The category plus the error name is enough to triage.
  const name = error instanceof Error ? error.name : 'UnknownError';
  return new InferenceTransportError({ detail: `inference request failed (${name})` });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function resolveBaseUrl(override: string | undefined, fallback: string): string {
  return optionalString(override) ?? fallback;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
