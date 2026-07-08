import type {
  ApiErrorBody,
  GetSessionContextRequest,
  GetSessionRequest,
  IngestRequest,
  IngestResponse,
  ListEventsRequest,
  ListSessionsRequest,
  RawEvent,
  RecallContextExpansion,
  RecallRequest,
  RecallResponse,
  RecentSessionRecord,
  ServiceInfo,
  SessionDetail,
} from './types.js';

// Bound every request so a hung service can never wedge a caller indefinitely.
const DEFAULT_TIMEOUT_MS = 10_000;

export type SagaApiClientOptions = {
  authToken?: string | undefined;
  baseUrl: string;
  // Injectable for tests; defaults to the global fetch (Bun/Node 20+).
  fetch?: typeof fetch | undefined;
  // Per-request timeout in milliseconds; defaults to 10s.
  timeoutMs?: number | undefined;
};

// Thrown for any non-2xx response, and for transport/timeout/parse failures.
// `code`/`message` come from the service's `{ error: { code, message } }` body
// when present, falling back to the status; synthetic codes cover the client-
// side failures. `cause` carries the originating error when there is one.
export class SagaApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SagaApiError';
    this.code = code;
    this.status = status;
  }
}

export class SagaApiClient {
  readonly #baseUrl: string;
  readonly #authToken: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: SagaApiClientOptions) {
    // Normalize away a single trailing slash so path joins never double up.
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#authToken = options.authToken;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  info(): Promise<ServiceInfo> {
    return this.#request<ServiceInfo>('GET', '/v1/info');
  }

  recall(request: RecallRequest): Promise<RecallResponse> {
    return this.#request<RecallResponse>('POST', '/v1/recall', { body: request });
  }

  // The write path (SGA-238): stores raw events and optional session snapshots.
  // Returns a per-item ack; the acks mean STORED, not derived — the extraction
  // job turns stored snapshots into sessions/turns/segments asynchronously.
  ingest(request: IngestRequest): Promise<IngestResponse> {
    return this.#request<IngestResponse>('POST', '/v1/ingest', { body: request });
  }

  listSessions(request: ListSessionsRequest): Promise<RecentSessionRecord[]> {
    return this.#request<RecentSessionRecord[]>('GET', '/v1/sessions', {
      query: {
        activeOnly: request.activeOnly,
        harness: request.harness,
        limit: request.limit,
        workspaceId: request.workspaceId,
      },
    });
  }

  getSession(id: string, request: GetSessionRequest): Promise<SessionDetail> {
    return this.#request<SessionDetail>('GET', `/v1/sessions/${encodeURIComponent(id)}`, {
      query: {
        includeRawBody: request.includeRawBody,
        maxRawRecords: request.maxRawRecords,
        maxSegmentsPerTurn: request.maxSegmentsPerTurn,
        maxTurns: request.maxTurns,
        workspaceId: request.workspaceId,
      },
    });
  }

  // `segmentId` is the anchor segment the window expands around (mirrors the CLI
  // `recall show <segment-id>` and the MCP get_session_context handler).
  getSessionContext(
    segmentId: string,
    request: GetSessionContextRequest,
  ): Promise<RecallContextExpansion> {
    return this.#request<RecallContextExpansion>(
      'GET',
      `/v1/sessions/${encodeURIComponent(segmentId)}/context`,
      {
        query: {
          afterTurns: request.afterTurns,
          beforeTurns: request.beforeTurns,
          windowTurns: request.windowTurns,
          workspaceId: request.workspaceId,
        },
      },
    );
  }

  listEvents(request: ListEventsRequest): Promise<RawEvent[]> {
    return this.#request<RawEvent[]>('GET', '/v1/events', {
      query: {
        limit: request.limit,
        workspaceId: request.workspaceId,
      },
    });
  }

  async #request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, boolean | number | string | undefined>;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    if (options.query !== undefined) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#authToken !== undefined) {
      headers.authorization = `Bearer ${this.#authToken}`;
    }
    const init: RequestInit = {
      headers,
      method,
      // Available on both Node 24 and Bun; rejects with a DOMException named
      // 'TimeoutError' once the deadline passes.
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), init);
    } catch (cause) {
      // Distinguish a timeout from any other transport failure so callers can
      // retry or surface a precise message.
      if (cause instanceof DOMException && cause.name === 'TimeoutError') {
        throw new SagaApiError(0, 'timeout', 'the saga service request timed out', { cause });
      }
      throw new SagaApiError(0, 'network', 'could not reach the saga service', { cause });
    }

    if (!response.ok) {
      throw await toApiError(response);
    }
    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded service JSON; T is the caller-declared wire response type
      return (await response.json()) as T;
    } catch (cause) {
      throw new SagaApiError(
        response.status,
        'invalid_response',
        'service returned a non-JSON response',
        { cause },
      );
    }
  }
}

async function toApiError(response: Response): Promise<SagaApiError> {
  let code = `http_${String(response.status)}`;
  let message = response.statusText || `request failed with status ${String(response.status)}`;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- error body is validated field-by-field below
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error !== undefined) {
      if (typeof body.error.code === 'string') {
        code = body.error.code;
      }
      if (typeof body.error.message === 'string') {
        message = body.error.message;
      }
    }
  } catch {
    // Non-JSON error body: keep the status-derived code/message.
  }
  return new SagaApiError(response.status, code, message);
}
