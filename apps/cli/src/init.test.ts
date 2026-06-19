import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BINDING_FILE_NAME, normalizeHandle, readBindingFile, writeBindingFile } from "./init.js";

describe("normalizeHandle", () => {
  test("creates lowercase slug handles", () => {
    expect(normalizeHandle("Saga Workspace!")).toBe("saga-workspace");
  });

  test("falls back for empty handles", () => {
    expect(normalizeHandle("!!!")).toBe("workspace");
  });
});

describe("writeBindingFile", () => {
  test("writes local binding json", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "saga-init-"));
    const bindingPath = writeBindingFile(projectRoot, {
      project: {
        gitRemote: "git@github.com:dbtlr/saga.git",
        root: projectRoot,
      },
      schemaVersion: 1,
      service: {
        databaseUrl: "env:DATABASE_URL",
      },
      sourceBinding: {
        id: "source-id",
      },
      workspace: {
        handle: "saga",
        id: "workspace-id",
      },
    });

    expect(bindingPath).toBe(join(projectRoot, BINDING_FILE_NAME));
    expect(JSON.parse(readFileSync(bindingPath, "utf8"))).toEqual({
      project: {
        gitRemote: "git@github.com:dbtlr/saga.git",
        root: projectRoot,
      },
      schemaVersion: 1,
      service: {
        databaseUrl: "env:DATABASE_URL",
      },
      sourceBinding: {
        id: "source-id",
      },
      workspace: {
        handle: "saga",
        id: "workspace-id",
      },
    });
    expect(readBindingFile(projectRoot)?.workspace.handle).toBe("saga");
  });
});
