import { describe, expect, test } from "vitest";
import { resolveConnector, rewriteConnectorReferencesToSagaLinks } from "./index.js";

describe("resolveConnector", () => {
  test("resolves GitHub pull requests through a configured repository", () => {
    const result = resolveConnector({
      externalId: "pr:12",
      sourceBinding: {
        config: {
          repositoryFullName: "dbtlr/saga",
        },
        id: "github-source",
        sourceType: "github",
        sourceUri: "github://dbtlr/saga",
      },
    });

    expect(result).toMatchObject({
      content: "GitHub pull request #12 in dbtlr/saga",
      provenance: {
        connector: "github",
        repository: "dbtlr/saga",
      },
      target: {
        apiUrl: "https://api.github.com/repos/dbtlr/saga/pulls/12",
        kind: "pr",
        url: "https://github.com/dbtlr/saga/pull/12",
      },
    });
  });

  test("resolves Mimir and Norn sources without owning their domains", () => {
    expect(
      resolveConnector({
        externalId: "SGA-72",
        sourceBinding: {
          id: "mimir-source",
          sourceType: "mimir",
          sourceUri: "mimir://SGA",
        },
      }),
    ).toMatchObject({
      content: "Mimir work item: SGA-72",
      target: {
        url: "mimir:SGA-72",
      },
    });

    expect(
      resolveConnector({
        externalId: "cli-output-spec",
        sourceBinding: {
          id: "norn-source",
          sourceType: "norn",
          sourceUri: "norn://workspace",
        },
      }),
    ).toMatchObject({
      content: "Norn document: cli-output-spec",
      target: {
        url: "norn:cli-output-spec",
      },
    });
  });

  test("resolves generic document-store sources", () => {
    expect(
      resolveConnector({
        externalId: "ENG-CI-CD-QUALITY-GATES",
        sourceBinding: {
          id: "confluence-source",
          sourceType: "confluence",
          sourceUri: "https://confluence.example/wiki",
        },
        title: "Quality Gates",
      }),
    ).toMatchObject({
      content: "Quality Gates from confluence",
      target: {
        kind: "document",
        url: "https://confluence.example/wiki/ENG-CI-CD-QUALITY-GATES",
      },
    });
  });

  test("rejects unsupported source types", () => {
    expect(() =>
      resolveConnector({
        externalId: "x",
        sourceBinding: {
          id: "unsupported-source",
          sourceType: "spreadsheet",
          sourceUri: "spreadsheet://local",
        },
      }),
    ).toThrow("unsupported connector source type: spreadsheet");
  });
});

describe("rewriteConnectorReferencesToSagaLinks", () => {
  test("rewrites matching connector references to Saga Links", () => {
    const rewritten = rewriteConnectorReferencesToSagaLinks(
      [
        {
          connector: "vault",
          externalId: "notes/saga-v2-architecture-seed.md",
          sourceBindingId: "source-1",
          title: "Architecture Seed",
          url: "file:///vault/notes/saga-v2-architecture-seed.md",
        },
        {
          connector: "git",
          externalId: "README.md",
          sourceBindingId: "source-2",
          url: "https://github.com/dbtlr/saga/blob/main/README.md",
        },
      ],
      [
        {
          connector: "vault",
          externalId: "notes/saga-v2-architecture-seed.md",
          sagaLink: "saga:context/architecture-seed",
          sourceBindingId: "source-1",
        },
      ],
    );

    expect(rewritten[0]).toMatchObject({
      originalUrl: "file:///vault/notes/saga-v2-architecture-seed.md",
      sagaLink: "saga:context/architecture-seed",
      url: "saga:context/architecture-seed",
    });
    expect(rewritten[1]).toEqual({
      connector: "git",
      externalId: "README.md",
      sourceBindingId: "source-2",
      url: "https://github.com/dbtlr/saga/blob/main/README.md",
    });
  });

  test("does not rewrite a matching connector and external id from a different source binding", () => {
    const rewritten = rewriteConnectorReferencesToSagaLinks(
      [
        {
          connector: "vault",
          externalId: "README.md",
          sourceBindingId: "source-2",
          url: "file:///second-vault/README.md",
        },
      ],
      [
        {
          connector: "vault",
          externalId: "README.md",
          sagaLink: "saga:context/first-readme",
          sourceBindingId: "source-1",
        },
      ],
    );

    expect(rewritten[0]).toEqual({
      connector: "vault",
      externalId: "README.md",
      sourceBindingId: "source-2",
      url: "file:///second-vault/README.md",
    });
  });
});
