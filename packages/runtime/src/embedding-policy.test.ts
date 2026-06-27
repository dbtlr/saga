import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveEmbeddingPolicy } from "./embedding-policy.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "saga-embedding-policy-"));
}

function writeSagaConfig(home: string, contents: string): void {
  mkdirSync(join(home, ".saga"), { recursive: true });
  writeFileSync(join(home, ".saga", "config.json"), contents);
}

describe("resolveEmbeddingPolicy", () => {
  test("reads enabled remote embeddings from the installation config", () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ embeddings: { remote: "enabled" } }));

    const policy = resolveEmbeddingPolicy({ env: {}, homeDir: home });

    expect(policy).toMatchObject({
      remoteEmbeddings: "enabled",
      source: "installation-config",
    });
  });

  test("reads an explicit disabled standard from the installation config", () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ embeddings: { remote: "disabled" } }));

    const policy = resolveEmbeddingPolicy({ env: {}, homeDir: home });

    expect(policy).toMatchObject({
      remoteEmbeddings: "disabled",
      source: "installation-config",
    });
  });

  test("defaults to disabled when no installation config file exists", () => {
    const home = tempHome();

    const policy = resolveEmbeddingPolicy({ env: {}, homeDir: home });

    expect(policy).toMatchObject({
      remoteEmbeddings: "disabled",
      source: "default",
    });
  });

  test("defaults to disabled when the config omits embeddings.remote", () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ embeddings: {} }));

    const policy = resolveEmbeddingPolicy({ env: {}, homeDir: home });

    expect(policy).toMatchObject({
      remoteEmbeddings: "disabled",
      source: "default",
    });
  });

  test("defaults to disabled for non-canonical remote values", () => {
    const home = tempHome();
    for (const remote of [true, "ENABLED", "yes", 1, null]) {
      writeSagaConfig(home, JSON.stringify({ embeddings: { remote } }));
      const policy = resolveEmbeddingPolicy({ env: {}, homeDir: home });
      expect(policy).toMatchObject({ remoteEmbeddings: "disabled", source: "default" });
    }
  });

  test("fails closed to disabled when the config is malformed JSON", () => {
    const home = tempHome();
    writeSagaConfig(home, "{ not valid json");

    const policy = resolveEmbeddingPolicy({ env: {}, homeDir: home });

    expect(policy.remoteEmbeddings).toBe("disabled");
    expect(policy.source).toBe("default");
    expect(policy.detail.toLowerCase()).toContain("parse");
  });

  test("fails closed to disabled when the config is unreadable", () => {
    const home = tempHome();

    const policy = resolveEmbeddingPolicy({
      env: {},
      homeDir: home,
      readFile: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    expect(policy.remoteEmbeddings).toBe("disabled");
    expect(policy.source).toBe("default");
  });

  test("reads SAGA_HOME/config.json ahead of the user home config", () => {
    const home = tempHome();
    const sagaHome = join(home, "saga-home");
    mkdirSync(sagaHome, { recursive: true });
    writeFileSync(
      join(sagaHome, "config.json"),
      JSON.stringify({ embeddings: { remote: "enabled" } }),
    );
    // A disabled standard in the user home must be overridden by SAGA_HOME.
    writeSagaConfig(home, JSON.stringify({ embeddings: { remote: "disabled" } }));

    const policy = resolveEmbeddingPolicy({ env: { SAGA_HOME: sagaHome }, homeDir: home });

    expect(policy).toMatchObject({
      remoteEmbeddings: "enabled",
      source: "installation-config",
    });
  });
});
