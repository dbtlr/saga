import { describe, expect, test } from "vitest";
import { embeddingWorkflowFromCodexAuth } from "./embeddings.js";

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
});
