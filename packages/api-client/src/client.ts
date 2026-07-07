import type {
  ApiErrorBody,
  GetSessionContextRequest,
  GetSessionRequest,
  ListEventsRequest,
  ListSessionsRequest,
  RawEvent,
  RecallContextExpansion,
  RecallRequest,
  RecallSearchResult,
  RecentSessionRecord,
  ServiceInfo,
  SessionDetail,
} from './types.js';

export type SagaApiClientOptions = {
  authToken?: string | undefined;
  baseUrl: string;
  // Injectable for tests; defaults to the global fetch (Bun/Node 20+).
  fetch?: typeof fetch | undefined;
};

// Thrown for any non-2xx response. `code`/`message` come from the service's
// `{ error: { code, message } }` body when present, falling back to the status.
export class SagaApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SagaApiError';
    this.code = code;
    this.status = status;
  }
}

export class SagaApiClient {
  readonly #baseUrl: string;
  readonly #authToken: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: SagaApiClientOptions) {
    // Normalize away a single trailing slash so path joins never double up.
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#authToken = options.authToken;
    this.#fetch = options.fetch ?? fetch;
  }

  info(): Promise<ServiceInfo> {
    return this.#request<ServiceInfo>('GET', '/v1/info');
  }

  recall(request: RecallRequest): Promise<RecallSearchResult> {
    return this.#request<RecallSearchResult>('POST', '/v1/recall', { body: request });
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
    const init: RequestInit = { headers, method };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await this.#fetch(url.toString(), init);
    if (!response.ok) {
      throw await toApiError(response);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoded service JSON; T is the caller-declared wire response type
    return (await response.json()) as T;
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
