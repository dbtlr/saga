import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { embeddingWorkflowFromCodexAuth, inspectEmbeddingWorkflow } from "./embeddings.js";

describe("embeddingWorkflowFromCodexAuth", () => {
  test("represents the default OpenAI embedding provider when Codex has a cached API key", () => {
    const workflow = embeddingWorkflowFromCodexAuth({
      authFile: "/tmp/auth.json",
      checkedFiles: [],
      detail: "cached OPENAI_API_KEY found in CODEX_HOME/auth.json",
      displayPath: "CODEX_HOME/auth.json",
      guidance: "available",
      mode: "api-key",
      openaiApiKey: "sk-secret",
      source: "codex-home",
      status: "available",
    });

    expect(workflow.provider).toEqual({
      dimensions: 1536,
      id: "openai",
      model: "text-embedding-3-small",
    });
    expect(workflow.availability).toMatchObject({
      reason: "openai-api-key-available",
      state: "available",
    });
    expect(workflow.lexicalFallback.state).toBe("standby");
    expect(JSON.stringify(workflow)).not.toContain("sk-secret");
  });

  test("represents skipped embeddings with active lexical fallback when credentials are unavailable", () => {
    const workflow = embeddingWorkflowFromCodexAuth({
      checkedFiles: [],
      detail: "no Codex auth file found",
      guidance: "Embedding generation is skipped. Lexical recall remains available.",
      mode: "missing",
      reason: "missing-auth-file",
      status: "unavailable",
    });

    expect(workflow.provider).toMatchObject({
      dimensions: 1536,
      id: "openai",
      model: "text-embedding-3-small",
    });
    expect(workflow.availability).toMatchObject({
      reason: "missing-auth-file",
      state: "skipped",
    });
    expect(workflow.lexicalFallback).toEqual({
      detail: "Lexical recall remains available while embedding generation is skipped.",
      state: "active",
    });
  });

  test("keeps malformed auth parser text and source excerpts out of workflow status", () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-embedding-auth-"));
    const codexHome = join(cwd, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "auth.json"),
      '{"OPENAI_API_KEY":"sk-workflow-leak","tokens":{"access_token":"tok-workflow-leak",}',
    );

    const workflow = inspectEmbeddingWorkflow({
      env: { CODEX_HOME: codexHome },
      homeDir: join(cwd, "home"),
    });
    const publicStatus = JSON.stringify(workflow);

    expect(workflow.availability).toMatchObject({
      reason: "malformed-auth-file",
      state: "skipped",
    });
    expect(workflow.availability.credential.detail).toBe("could not parse CODEX_HOME/auth.json");
    expect(publicStatus).not.toContain("sk-workflow-leak");
    expect(publicStatus).not.toContain("tok-workflow-leak");
    expect(publicStatus).not.toContain("OPENAI_API_KEY");
    expect(publicStatus).not.toContain("access_token");
    expect(publicStatus).not.toContain("Unexpected");
    expect(publicStatus).not.toContain("JSON");
  });
});
