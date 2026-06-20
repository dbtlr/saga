export const packageName = "@saga/connectors";

export interface ConnectorSourceBinding {
  config?: Record<string, unknown> | undefined;
  id: string;
  sourceType: string;
  sourceUri: string;
}

export interface ConnectorReference {
  connector: string;
  externalId: string;
  sourceBindingId: string;
  title?: string | undefined;
  url?: string | undefined;
}

export interface SagaLinkIndexReference {
  connector: string;
  externalId: string;
  sagaLink: string;
  sourceBindingId: string;
}

export interface ConnectorRetrievalResult {
  content?: string | undefined;
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
}

export interface SagaLinkedReference extends ConnectorReference {
  originalUrl?: string | undefined;
  sagaLink?: string | undefined;
  url?: string | undefined;
}

export interface SagaLinkedRetrievalResult extends Omit<ConnectorRetrievalResult, "references"> {
  references: SagaLinkedReference[];
}

export interface ResolveConnectorInput {
  externalId: string;
  metadata?: Record<string, unknown> | undefined;
  sourceBinding: ConnectorSourceBinding;
  title?: string | undefined;
}

export interface ConnectorAdapter {
  resolve: (input: ResolveConnectorInput) => ConnectorRetrievalResult;
  sourceTypes: readonly string[];
}

export const CONNECTOR_ADAPTERS = [
  createGitHubConnector(),
  createMimirConnector(),
  createNornConnector(),
  createDocumentStoreConnector(),
] as const satisfies readonly ConnectorAdapter[];

export function resolveConnector(
  input: ResolveConnectorInput,
  adapters: readonly ConnectorAdapter[] = CONNECTOR_ADAPTERS,
): ConnectorRetrievalResult {
  const sourceType = normalizeSourceType(input.sourceBinding.sourceType);
  const adapter = adapters.find((candidate) =>
    candidate.sourceTypes.some((supported) => normalizeSourceType(supported) === sourceType),
  );
  if (adapter === undefined) {
    throw new Error(`unsupported connector source type: ${input.sourceBinding.sourceType}`);
  }

  return adapter.resolve(input);
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
    if (sagaLink === undefined) return { ...reference };

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
    resolve: (input) => {
      const repository = readRepository(input.sourceBinding);
      const target = parseGitHubExternalId(input.externalId);
      const url = githubWebUrl(repository, target);

      return {
        content: `${githubLabel(target)} in ${repository}`,
        provenance: {
          connector: "github",
          repository,
        },
        references: readMetadataReferences(input).map((reference) => ({
          connector: "github",
          externalId: reference.externalId,
          sourceBindingId: reference.sourceBindingId ?? input.sourceBinding.id,
          title: reference.title,
          url: reference.url,
        })),
        target: {
          apiUrl: githubApiUrl(repository, target),
          externalId: input.externalId,
          kind: target.kind,
          sourceBindingId: input.sourceBinding.id,
          sourceType: input.sourceBinding.sourceType,
          sourceUri: input.sourceBinding.sourceUri,
          url,
        },
      };
    },
    sourceTypes: ["github"],
  };
}

function createMimirConnector(): ConnectorAdapter {
  return simpleConnector({
    connector: "mimir",
    label: "Mimir work item",
    sourceTypes: ["mimir"],
    urlPrefix: "mimir:",
  });
}

function createNornConnector(): ConnectorAdapter {
  return simpleConnector({
    connector: "norn",
    label: "Norn document",
    sourceTypes: ["norn"],
    urlPrefix: "norn:",
  });
}

function createDocumentStoreConnector(): ConnectorAdapter {
  return {
    resolve: (input) => {
      const connector = normalizeSourceType(input.sourceBinding.sourceType);
      const baseUrl = input.sourceBinding.sourceUri.replace(/\/$/u, "");
      const url = `${baseUrl}/${encodeURIComponent(input.externalId)}`;
      return {
        content: `${input.title ?? input.externalId} from ${connector}`,
        provenance: {
          connector,
        },
        references: readMetadataReferences(input).map((reference) => ({
          connector: reference.connector ?? connector,
          externalId: reference.externalId,
          sourceBindingId: reference.sourceBindingId ?? input.sourceBinding.id,
          title: reference.title,
          url: reference.url,
        })),
        target: {
          externalId: input.externalId,
          kind: "document",
          sourceBindingId: input.sourceBinding.id,
          sourceType: input.sourceBinding.sourceType,
          sourceUri: input.sourceBinding.sourceUri,
          url,
        },
      };
    },
    sourceTypes: ["confluence", "document", "docs", "notion", "vault"],
  };
}

function simpleConnector(input: {
  connector: string;
  label: string;
  sourceTypes: readonly string[];
  urlPrefix: string;
}): ConnectorAdapter {
  return {
    resolve: (request) => ({
      content: `${input.label}: ${request.externalId}`,
      provenance: {
        connector: input.connector,
      },
      references: readMetadataReferences(request).map((reference) => ({
        connector: reference.connector ?? input.connector,
        externalId: reference.externalId,
        sourceBindingId: reference.sourceBindingId ?? request.sourceBinding.id,
        title: reference.title,
        url: reference.url,
      })),
      target: {
        externalId: request.externalId,
        kind: "document",
        sourceBindingId: request.sourceBinding.id,
        sourceType: request.sourceBinding.sourceType,
        sourceUri: request.sourceBinding.sourceUri,
        url: `${input.urlPrefix}${request.externalId}`,
      },
    }),
    sourceTypes: input.sourceTypes,
  };
}

function readRepository(sourceBinding: ConnectorSourceBinding): string {
  const configured = readString(
    sourceBinding.config?.repositoryFullName ?? sourceBinding.config?.repository,
  );
  if (configured !== undefined) return validateGitHubRepository(configured);

  if (sourceBinding.sourceUri.startsWith("github://")) {
    return validateGitHubRepository(
      sourceBinding.sourceUri.slice("github://".length).replace(/^\/+/u, ""),
    );
  }

  const match = /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/u.exec(sourceBinding.sourceUri);
  if (match?.[1] !== undefined) return validateGitHubRepository(match[1]);

  throw new Error(
    "GitHub connector requires repositoryFullName, repository, or github://owner/repo sourceUri",
  );
}

function validateGitHubRepository(repository: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) return repository;
  throw new Error(`invalid GitHub repository: ${repository}`);
}

function parseGitHubExternalId(externalId: string): { id: string; kind: string } {
  const [kind, ...rest] = externalId.split(":");
  const id = rest.join(":");
  if ((kind === "issue" || kind === "pr") && /^[1-9][0-9]*$/u.test(id)) {
    return { id, kind };
  }
  if (kind === "commit" && /^[0-9a-f]{7,40}$/iu.test(id)) {
    return { id, kind };
  }

  throw new Error(`unsupported GitHub external id: ${externalId}`);
}

function githubLabel(target: { id: string; kind: string }): string {
  if (target.kind === "pr") return `GitHub pull request #${target.id}`;
  if (target.kind === "issue") return `GitHub issue #${target.id}`;
  if (target.kind === "commit") return `GitHub commit ${target.id}`;
  return `GitHub resource ${target.id}`;
}

function githubWebUrl(repository: string, target: { id: string; kind: string }): string {
  const base = `https://github.com/${repository}`;
  if (target.kind === "pr") return `${base}/pull/${target.id}`;
  if (target.kind === "issue") return `${base}/issues/${target.id}`;
  if (target.kind === "commit") return `${base}/commit/${target.id}`;
  return `${base}/${target.id}`;
}

function githubApiUrl(repository: string, target: { id: string; kind: string }): string {
  const base = `https://api.github.com/repos/${repository}`;
  if (target.kind === "pr") return `${base}/pulls/${target.id}`;
  if (target.kind === "issue") return `${base}/issues/${target.id}`;
  if (target.kind === "commit") return `${base}/commits/${target.id}`;
  return base;
}

function readMetadataReferences(
  input: Pick<ResolveConnectorInput, "metadata" | "sourceBinding">,
): Array<{
  connector?: string | undefined;
  externalId: string;
  sourceBindingId?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
}> {
  const references = input.metadata?.references;
  if (!Array.isArray(references)) return [];

  return references.flatMap((reference) => {
    if (!isRecord(reference)) return [];
    const externalId = readString(reference.externalId);
    if (externalId === undefined) return [];

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
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
