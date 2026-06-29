import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const packageName = '@saga/connectors';

export type ConnectorSourceBinding = {
  config?: Record<string, unknown> | undefined;
  id: string;
  sourceType: string;
  sourceUri: string;
};

export type ConnectorReference = {
  connector: string;
  externalId: string;
  sourceBindingId: string;
  title?: string | undefined;
  url?: string | undefined;
};

export type SagaLinkIndexReference = {
  connector: string;
  externalId: string;
  sagaLink: string;
  sourceBindingId: string;
};

export type ConnectorRetrievalResult = {
  content?: string | undefined;
  evidence?: Record<string, unknown> | undefined;
  provenance?: Record<string, unknown> | undefined;
  references: readonly ConnectorReference[];
  target?: {
    apiUrl?: string | undefined;
    externalId: string;
    kind?: string | undefined;
    sourceBindingId: string;
    sourceType: string;
    sourceUri: string;
    url?: string | undefined;
  };
};

export type SagaLinkedReference = {
  originalUrl?: string | undefined;
  sagaLink?: string | undefined;
  url?: string | undefined;
} & ConnectorReference;

export type SagaLinkedRetrievalResult = {
  references: SagaLinkedReference[];
} & Omit<ConnectorRetrievalResult, 'references'>;

export type ResolveConnectorInput = {
  externalId: string;
  metadata?: Record<string, unknown> | undefined;
  sourceBinding: ConnectorSourceBinding;
  title?: string | undefined;
};

export type ConnectorRetrieveInput = {
  target: NonNullable<ConnectorRetrievalResult['target']>;
} & ResolveConnectorInput;

export type ConnectorRetrievedRecord = {
  content: string;
  evidence?: Record<string, unknown> | undefined;
  references?: readonly ConnectorReference[] | undefined;
};

export type ConnectorClient = {
  retrieve: (input: ConnectorRetrieveInput) => Promise<ConnectorRetrievedRecord>;
};

export type ConnectorClients = {
  document?: ConnectorClient | undefined;
  github?: ConnectorClient | undefined;
  mimir?: ConnectorClient | undefined;
  norn?: ConnectorClient | undefined;
};

export type ResolveConnectorContext = {
  clients?: ConnectorClients | undefined;
};

export type ConnectorAdapter = {
  resolve: (
    input: ResolveConnectorInput,
    context: ResolveConnectorContext,
  ) => Promise<ConnectorRetrievalResult>;
  sourceTypes: readonly string[];
};

export const CONNECTOR_ADAPTERS = [
  createGitHubConnector(),
  createMimirConnector(),
  createNornConnector(),
  createDocumentStoreConnector(),
] as const satisfies readonly ConnectorAdapter[];

export async function resolveConnector(
  input: ResolveConnectorInput,
  context: ResolveConnectorContext = {},
  adapters: readonly ConnectorAdapter[] = CONNECTOR_ADAPTERS,
): Promise<ConnectorRetrievalResult> {
  const sourceType = normalizeSourceType(input.sourceBinding.sourceType);
  const adapter = adapters.find((candidate) =>
    candidate.sourceTypes.some((supported) => normalizeSourceType(supported) === sourceType),
  );
  if (adapter === undefined) {
    throw new Error(`unsupported connector source type: ${input.sourceBinding.sourceType}`);
  }

  return adapter.resolve(input, context);
}

export function rewriteConnectorReferencesToSagaLinks(
  references: readonly ConnectorReference[],
  index: readonly SagaLinkIndexReference[],
): SagaLinkedReference[] {
  const sagaLinks = new Map(
    index.map((entry) => [
      connectorReferenceKey(entry.sourceBindingId, entry.externalId),
      entry.sagaLink,
    ]),
  );

  return references.map((reference) => {
    const sagaLink = sagaLinks.get(
      connectorReferenceKey(reference.sourceBindingId, reference.externalId),
    );
    if (sagaLink === undefined) {
      return { ...reference };
    }

    return {
      ...reference,
      originalUrl: reference.url,
      sagaLink,
      url: sagaLink,
    };
  });
}

export function rewriteConnectorResultToSagaLinks(
  result: ConnectorRetrievalResult,
  index: readonly SagaLinkIndexReference[],
): SagaLinkedRetrievalResult {
  return {
    ...result,
    references: rewriteConnectorReferencesToSagaLinks(result.references, index),
  };
}

export function connectorReferenceKey(sourceBindingId: string, externalId: string): string {
  return `${sourceBindingId.trim()}\u0000${externalId.trim()}`;
}

function createGitHubConnector(): ConnectorAdapter {
  return {
    resolve: async (input, context) => {
      const repository = readRepository(input.sourceBinding);
      const target = parseGitHubExternalId(input.externalId);
      const url = githubWebUrl(repository, target);
      const connectorTarget = {
        apiUrl: githubApiUrl(repository, target),
        externalId: input.externalId,
        kind: target.kind,
        sourceBindingId: input.sourceBinding.id,
        sourceType: input.sourceBinding.sourceType,
        sourceUri: input.sourceBinding.sourceUri,
        url,
      };
      const record = await (context.clients?.github ?? createDefaultGitHubClient()).retrieve({
        ...input,
        target: connectorTarget,
      });

      return {
        content: record.content,
        evidence: record.evidence,
        provenance: {
          connector: 'github',
          repository,
        },
        references: mergeReferences(
          input,
          'github',
          record.references,
          readMetadataReferences(input),
        ),
        target: connectorTarget,
      };
    },
    sourceTypes: ['github'],
  };
}

function createMimirConnector(): ConnectorAdapter {
  return simpleConnector({
    connector: 'mimir',
    label: 'Mimir work item',
    sourceTypes: ['mimir'],
    urlPrefix: 'mimir:',
  });
}

function createNornConnector(): ConnectorAdapter {
  return simpleConnector({
    connector: 'norn',
    label: 'Norn document',
    sourceTypes: ['norn'],
    urlPrefix: 'norn:',
  });
}

function createDocumentStoreConnector(): ConnectorAdapter {
  return {
    resolve: async (input, context) => {
      const connector = normalizeSourceType(input.sourceBinding.sourceType);
      const baseUrl = input.sourceBinding.sourceUri.replace(/\/$/u, '');
      const url = joinDocumentUrl(baseUrl, input.externalId);
      const connectorTarget = {
        externalId: input.externalId,
        kind: 'document',
        sourceBindingId: input.sourceBinding.id,
        sourceType: input.sourceBinding.sourceType,
        sourceUri: input.sourceBinding.sourceUri,
        url,
      };
      const record = await (context.clients?.document ?? createDefaultDocumentClient()).retrieve({
        ...input,
        target: connectorTarget,
      });

      return {
        content: record.content,
        evidence: record.evidence,
        provenance: {
          connector,
        },
        references: mergeReferences(
          input,
          connector,
          record.references,
          readMetadataReferences(input),
        ),
        target: connectorTarget,
      };
    },
    sourceTypes: ['confluence', 'document', 'docs', 'notion', 'vault'],
  };
}

function simpleConnector(input: {
  connector: string;
  label: string;
  sourceTypes: readonly string[];
  urlPrefix: string;
}): ConnectorAdapter {
  return {
    resolve: async (request, context) => {
      const target = {
        externalId: request.externalId,
        kind: 'document',
        sourceBindingId: request.sourceBinding.id,
        sourceType: request.sourceBinding.sourceType,
        sourceUri: request.sourceBinding.sourceUri,
        url: `${input.urlPrefix}${request.externalId}`,
      };
      const client = input.connector === 'mimir' ? context.clients?.mimir : context.clients?.norn;
      const record = await (client ?? createDefaultMetadataClient(input.label)).retrieve({
        ...request,
        target,
      });

      return {
        content: record.content,
        evidence: record.evidence,
        provenance: {
          connector: input.connector,
        },
        references: mergeReferences(
          request,
          input.connector,
          record.references,
          readMetadataReferences(request),
        ),
        target,
      };
    },
    sourceTypes: input.sourceTypes,
  };
}

function readRepository(sourceBinding: ConnectorSourceBinding): string {
  const configured = readString(
    sourceBinding.config?.repositoryFullName ?? sourceBinding.config?.repository,
  );
  if (configured !== undefined) {
    return validateGitHubRepository(configured);
  }

  if (sourceBinding.sourceUri.startsWith('github://')) {
    return validateGitHubRepository(
      sourceBinding.sourceUri.slice('github://'.length).replace(/^\/+/u, ''),
    );
  }

  const match = /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/u.exec(sourceBinding.sourceUri);
  if (match?.[1] !== undefined) {
    return validateGitHubRepository(match[1]);
  }

  throw new Error(
    'GitHub connector requires repositoryFullName, repository, or github://owner/repo sourceUri',
  );
}

function validateGitHubRepository(repository: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    return repository;
  }
  throw new Error(`invalid GitHub repository: ${repository}`);
}

function parseGitHubExternalId(externalId: string): { id: string; kind: string } {
  const [kind, ...rest] = externalId.split(':');
  const id = rest.join(':');
  if ((kind === 'issue' || kind === 'pr') && /^[1-9][0-9]*$/u.test(id)) {
    return { id, kind };
  }
  if (kind === 'commit' && /^[0-9a-f]{7,40}$/iu.test(id)) {
    return { id, kind };
  }

  throw new Error(`unsupported GitHub external id: ${externalId}`);
}

function githubWebUrl(repository: string, target: { id: string; kind: string }): string {
  const base = `https://github.com/${repository}`;
  if (target.kind === 'pr') {
    return `${base}/pull/${target.id}`;
  }
  if (target.kind === 'issue') {
    return `${base}/issues/${target.id}`;
  }
  if (target.kind === 'commit') {
    return `${base}/commit/${target.id}`;
  }
  return `${base}/${target.id}`;
}

function githubApiUrl(repository: string, target: { id: string; kind: string }): string {
  const base = `https://api.github.com/repos/${repository}`;
  if (target.kind === 'pr') {
    return `${base}/pulls/${target.id}`;
  }
  if (target.kind === 'issue') {
    return `${base}/issues/${target.id}`;
  }
  if (target.kind === 'commit') {
    return `${base}/commits/${target.id}`;
  }
  return base;
}

function createDefaultGitHubClient(): ConnectorClient {
  return {
    retrieve: async (input) => {
      if (input.target.apiUrl === undefined) {
        throw new Error('GitHub connector target is missing apiUrl');
      }

      const response = await fetch(input.target.apiUrl, {
        headers: githubHeaders(input.sourceBinding),
      });
      if (!response.ok) {
        throw new Error(`GitHub connector request failed: ${response.status.toString()}`);
      }

      const payload = await response.json();
      if (!isRecord(payload)) {
        throw new Error('GitHub connector returned a non-object response');
      }

      return {
        content: renderGitHubContent(input.target.kind, payload),
        evidence: {
          connector: 'github',
          payload,
        },
        references: [],
      };
    },
  };
}

function createDefaultDocumentClient(): ConnectorClient {
  return {
    retrieve: async (input) => {
      const metadataContent = readString(input.metadata?.content);
      if (metadataContent !== undefined) {
        return {
          content: metadataContent,
          evidence: { source: 'metadata' },
          references: [],
        };
      }

      if (input.target.url?.startsWith('file://') === true) {
        return {
          content: await readFile(fileURLToPath(input.target.url), 'utf8'),
          evidence: { source: input.target.url },
          references: [],
        };
      }

      if (
        input.target.url?.startsWith('http://') === true ||
        input.target.url?.startsWith('https://') === true
      ) {
        const response = await fetch(input.target.url);
        if (!response.ok) {
          throw new Error(`document connector request failed: ${response.status.toString()}`);
        }
        return {
          content: await response.text(),
          evidence: { source: input.target.url },
          references: [],
        };
      }

      throw new Error('document connector requires metadata.content, file URL, or HTTP URL');
    },
  };
}

function createDefaultMetadataClient(label: string): ConnectorClient {
  return {
    retrieve: async (input) => {
      const metadataContent = readString(input.metadata?.content);
      if (metadataContent === undefined) {
        throw new Error(`${label} connector requires metadata.content or an injected client`);
      }

      return {
        content: metadataContent,
        evidence: { source: 'metadata' },
        references: [],
      };
    },
  };
}

function githubHeaders(sourceBinding: ConnectorSourceBinding): Headers {
  const headers = new Headers({
    accept: 'application/vnd.github+json',
    'user-agent': 'saga',
  });
  const token = readString(sourceBinding.config?.token ?? sourceBinding.config?.authToken);
  if (token !== undefined) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return headers;
}

function renderGitHubContent(kind: string | undefined, payload: Record<string, unknown>): string {
  if (kind === 'pr' || kind === 'issue') {
    return [`# ${readString(payload.title) ?? 'Untitled'}`, '', readString(payload.body) ?? '']
      .join('\n')
      .trim();
  }

  if (kind === 'commit') {
    const commit = isRecord(payload.commit) ? payload.commit : {};
    return readString(commit.message) ?? readString(payload.sha) ?? 'GitHub commit';
  }

  return JSON.stringify(payload);
}

function mergeReferences(
  input: ResolveConnectorInput,
  defaultConnector: string,
  retrieved: readonly ConnectorReference[] | undefined,
  metadata: ReturnType<typeof readMetadataReferences>,
): ConnectorReference[] {
  return [
    ...(retrieved ?? []),
    ...metadata.map((reference) => ({
      connector: reference.connector ?? defaultConnector,
      externalId: reference.externalId,
      sourceBindingId: reference.sourceBindingId ?? input.sourceBinding.id,
      title: reference.title,
      url: reference.url,
    })),
  ];
}

function joinDocumentUrl(baseUrl: string, externalId: string): string {
  const path = encodeDocumentPath(externalId);
  return `${baseUrl}/${path}`;
}

function encodeDocumentPath(externalId: string): string {
  const segments = externalId.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`invalid document external id: ${externalId}`);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function readMetadataReferences(input: Pick<ResolveConnectorInput, 'metadata' | 'sourceBinding'>): {
  connector?: string | undefined;
  externalId: string;
  sourceBindingId?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
}[] {
  const references = input.metadata?.references;
  if (!Array.isArray(references)) {
    return [];
  }

  return references.flatMap((reference) => {
    if (!isRecord(reference)) {
      return [];
    }
    const externalId = readString(reference.externalId);
    if (externalId === undefined) {
      return [];
    }

    return [
      {
        connector: readString(reference.connector),
        externalId,
        sourceBindingId: readString(reference.sourceBindingId),
        title: readString(reference.title),
        url: readString(reference.url),
      },
    ];
  });
}

function normalizeSourceType(sourceType: string): string {
  return sourceType.trim().toLowerCase();
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
