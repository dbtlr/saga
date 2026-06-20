export const packageName = "@saga/connectors";

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
  references: readonly ConnectorReference[];
}

export interface SagaLinkedReference extends ConnectorReference {
  originalUrl?: string | undefined;
  sagaLink?: string | undefined;
  url?: string | undefined;
}

export interface SagaLinkedRetrievalResult extends Omit<ConnectorRetrievalResult, "references"> {
  references: SagaLinkedReference[];
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
