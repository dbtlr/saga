import { describe, expect, test } from "vitest";
import { rewriteConnectorReferencesToSagaLinks } from "./index.js";

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
