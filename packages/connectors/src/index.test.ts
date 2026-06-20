import { describe, expect, test } from "vitest";
import { resolveConnector, rewriteConnectorReferencesToSagaLinks } from "./index.js";

describe("resolveConnector", () => {
  test("retrieves GitHub pull requests through a configured repository", async () => {
    const result = await resolveConnector(
      {
        externalId: "pr:12",
        sourceBinding: {
          config: {
            repositoryFullName: "dbtlr/saga",
          },
          id: "github-source",
          sourceType: "github",
          sourceUri: "github://dbtlr/saga",
        },
      },
      {
        clients: {
          github: {
            retrieve: async (input) => ({
              content: "# Add connector adapters\n\nPull request body",
              evidence: {
                apiUrl: input.target.apiUrl,
                number: 12,
              },
              references: [],
            }),
          },
        },
      },
    );

    expect(result).toMatchObject({
      content: "# Add connector adapters\n\nPull request body",
      evidence: {
        apiUrl: "https://api.github.com/repos/dbtlr/saga/pulls/12",
        number: 12,
      },
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

  test("retrieves Mimir and Norn sources without owning their domains", async () => {
    await expect(
      resolveConnector({
        externalId: "SGA-72",
        metadata: {
          content: "Add GitHub connector",
        },
        sourceBinding: {
          id: "mimir-source",
          sourceType: "mimir",
          sourceUri: "mimir://SGA",
        },
      }),
    ).resolves.toMatchObject({
      content: "Add GitHub connector",
      evidence: {
        source: "metadata",
      },
      target: {
        url: "mimir:SGA-72",
      },
    });

    await expect(
      resolveConnector({
        externalId: "cli-output-spec",
        metadata: {
          content: "Norn CLI output standard",
        },
        sourceBinding: {
          id: "norn-source",
          sourceType: "norn",
          sourceUri: "norn://workspace",
        },
      }),
    ).resolves.toMatchObject({
      content: "Norn CLI output standard",
      target: {
        url: "norn:cli-output-spec",
      },
    });
  });

  test("retrieves generic document-store sources", async () => {
    await expect(
      resolveConnector({
        externalId: "ENG-CI-CD-QUALITY-GATES",
        metadata: {
          content: "Quality gate policy",
        },
        sourceBinding: {
          id: "confluence-source",
          sourceType: "confluence",
          sourceUri: "https://confluence.example/wiki",
        },
        title: "Quality Gates",
      }),
    ).resolves.toMatchObject({
      content: "Quality gate policy",
      target: {
        kind: "document",
        url: "https://confluence.example/wiki/ENG-CI-CD-QUALITY-GATES",
      },
    });

    await expect(
      resolveConnector({
        externalId: "notes/saga-v2-architecture-seed.md",
        metadata: {
          content: "Architecture seed",
        },
        sourceBinding: {
          id: "vault-source",
          sourceType: "vault",
          sourceUri: "file:///Users/drew/vaults/atlas",
        },
      }),
    ).resolves.toMatchObject({
      content: "Architecture seed",
      target: {
        url: "file:///Users/drew/vaults/atlas/notes/saga-v2-architecture-seed.md",
      },
    });
  });

  test("rejects invalid GitHub repositories and external ids", async () => {
    await expect(
      resolveConnector({
        externalId: "pr:../../settings",
        sourceBinding: {
          id: "github-source",
          sourceType: "github",
          sourceUri: "github://dbtlr/saga",
        },
      }),
    ).rejects.toThrow("unsupported GitHub external id");

    await expect(
      resolveConnector({
        externalId: "pr:1",
        sourceBinding: {
          config: {
            repositoryFullName: "dbtlr/saga/extra",
          },
          id: "github-source",
          sourceType: "github",
          sourceUri: "github://dbtlr/saga",
        },
      }),
    ).rejects.toThrow("invalid GitHub repository");
  });

  test("rejects unsupported source types", async () => {
    await expect(
      resolveConnector({
        externalId: "x",
        sourceBinding: {
          id: "unsupported-source",
          sourceType: "spreadsheet",
          sourceUri: "spreadsheet://local",
        },
      }),
    ).rejects.toThrow("unsupported connector source type: spreadsheet");
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
