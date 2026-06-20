export const packageName = "@saga/connectors";

export interface ConnectorReference {
  connector: string;
  externalId: string;
  title?: string | undefined;
  url?: string | undefined;
}

export interface SagaLinkIndexReference {
  connector: string;
  externalId: string;
  sagaLink: string;
}

export interface SagaLinkedReference extends ConnectorReference {
  originalUrl?: string | undefined;
  sagaLink?: string | undefined;
  url?: string | undefined;
}

export function rewriteConnectorReferencesToSagaLinks(
  references: readonly ConnectorReference[],
  index: readonly SagaLinkIndexReference[],
): SagaLinkedReference[] {
  const sagaLinks = new Map(
    index.map((entry) => [
      connectorReferenceKey(entry.connector, entry.externalId),
      entry.sagaLink,
    ]),
  );

  return references.map((reference) => {
    const sagaLink = sagaLinks.get(
      connectorReferenceKey(reference.connector, reference.externalId),
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

export function connectorReferenceKey(connector: string, externalId: string): string {
  return `${connector.trim().toLowerCase()}\u0000${externalId.trim()}`;
}
