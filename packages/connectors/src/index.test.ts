import { describe, expect, test } from "vitest";
import { rewriteConnectorReferencesToSagaLinks } from "./index.js";

describe("rewriteConnectorReferencesToSagaLinks", () => {
  test("rewrites matching connector references to Saga Links", () => {
    const rewritten = rewriteConnectorReferencesToSagaLinks(
      [
        {
          connector: "vault",
          externalId: "notes/saga-v2-architecture-seed.md",
          title: "Architecture Seed",
          url: "file:///vault/notes/saga-v2-architecture-seed.md",
        },
        {
          connector: "git",
          externalId: "README.md",
          url: "https://github.com/dbtlr/saga/blob/main/README.md",
        },
      ],
      [
        {
          connector: "vault",
          externalId: "notes/saga-v2-architecture-seed.md",
          sagaLink: "saga:context/architecture-seed",
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
      url: "https://github.com/dbtlr/saga/blob/main/README.md",
    });
  });
});
