import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  checkNodeVersion,
  doctorProject,
  renderDoctor,
  runDoctor,
  serviceDoctorStatus,
  satisfiesEngineRange,
  type DoctorCheck,
} from "./doctor.js";
import type { HarnessActivationStatus } from "./harness.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

const checks: DoctorCheck[] = [
  {
    detail: "v26.3.1",
    label: "node",
    status: "ok",
  },
  {
    detail: "DATABASE_URL is not set",
    label: "postgres",
    status: "warn",
  },
  {
    detail: "connection refused",
    label: "migrations",
    status: "fail",
  },
];

describe("renderDoctor", () => {
  test("renders unicode status tokens", () => {
    expect(
      renderDoctor(checks, { ascii: false, color: "never", format: "records", isTty: false }),
    ).toContain("postgres    ⚠ DATABASE_URL is not set");
  });

  test("renders ascii status tokens", () => {
    expect(
      renderDoctor(checks, { ascii: true, color: "never", format: "records", isTty: false }),
    ).toContain("migrations  [fail] connection refused");
  });

  test("renders newer migration compatibility failures", () => {
    expect(
      renderDoctor(
        [
          {
            detail:
              "database has newer migrations than this Saga build understands: 5 applied; expected 4. Upgrade Saga or restore a compatible backup before continuing.",
            label: "migrations",
            status: "fail",
          },
        ],
        { ascii: true, color: "never", format: "records", isTty: false },
      ),
    ).toContain("newer migrations");
  });
});

describe("runDoctor", () => {
  test("renders json output", async () => {
    const output = await runDoctor([], {
      ascii: true,
      color: "never",
      format: "json",
      isTty: false,
    });

    expect(Array.isArray(JSON.parse(output))).toBe(true);
  });
});

describe("doctorProject", () => {
  test("reports Node and pnpm engine requirements", async () => {
    const checks = await doctorProject({ cwd: workspaceRoot });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining("requires >=24.0.0 <27.0.0"),
        label: "node",
        status: "ok",
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining("requires ^11.0.0"),
        label: "pnpm",
        status: "ok",
      }),
    );
  });

  test("reports available embedding provider without exposing the cached API key", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    const homeDir = mkdtempSync(join(tmpdir(), "saga-codex-home-"));
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(
      join(homeDir, ".codex", "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-do-not-print" }),
    );

    const checks = await doctorProject({
      cwd,
      embeddingAuth: {
        env: {},
        homeDir,
      },
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "openai/text-embedding-3-small (1536 dimensions) available; cached OPENAI_API_KEY present in ~/.codex/auth.json; lexical fallback: standby",
        label: "embeddings",
        status: "ok",
      }),
    );
    expect(JSON.stringify(checks)).not.toContain("sk-do-not-print");
  });

  test("warns when embeddings are skipped and lexical recall remains available", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    const homeDir = mkdtempSync(join(tmpdir(), "saga-codex-home-"));
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(
      join(homeDir, ".codex", "auth.json"),
      JSON.stringify({
        account_id: "acct_123",
        tokens: {
          access_token: "token",
        },
      }),
    );

    const checks = await doctorProject({
      cwd,
      embeddingAuth: {
        env: {},
        homeDir,
      },
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "openai/text-embedding-3-small (1536 dimensions) skipped; Codex login/account tokens found in ~/.codex/auth.json, but no cached OPENAI_API_KEY is present; Embedding generation needs a cached OPENAI_API_KEY in Codex auth. Login/account tokens are read-only and will not be refreshed or rewritten. Lexical recall remains available.",
        label: "embeddings",
        status: "warn",
      }),
    );
  });

  test("does not expose malformed auth parser text or source excerpts in embeddings output", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    const codexHome = join(cwd, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "auth.json"),
      '{"OPENAI_API_KEY":"sk-doctor-leak","tokens":{"access_token":"tok-doctor-leak",}',
    );

    const checks = await doctorProject({
      cwd,
      embeddingAuth: {
        env: { CODEX_HOME: codexHome },
        homeDir: join(cwd, "home"),
      },
    });
    const output = renderDoctor(checks, {
      ascii: true,
      color: "never",
      format: "records",
      isTty: false,
    });
    const publicStatus = `${JSON.stringify(checks)}\n${output}`;

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "openai/text-embedding-3-small (1536 dimensions) skipped; could not parse CODEX_HOME/auth.json; Embedding generation is skipped; repair Codex auth or provide valid embedding credentials. Lexical recall remains available.",
        label: "embeddings",
        status: "warn",
      }),
    );
    expect(publicStatus).not.toContain("sk-doctor-leak");
    expect(publicStatus).not.toContain("tok-doctor-leak");
    expect(publicStatus).not.toContain("OPENAI_API_KEY");
    expect(publicStatus).not.toContain("access_token");
    expect(publicStatus).not.toContain("Unexpected");
    expect(publicStatus).not.toContain("JSON");
  });

  test("reports harness target states", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));

    const checks = await doctorProject({ cwd });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "missing; binding and hooks are not installed; activation: missing-binding; workspace binding is missing; run saga init; next step: run saga init and saga harness install codex before checking activation",
        label: "harness:codex",
        status: "warn",
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "missing; binding and hooks are not installed; activation: missing-binding; workspace binding is missing; run saga init; next step: run saga init and saga harness install claude before checking activation",
        label: "harness:claude",
        status: "warn",
      }),
    );
  });

  test("fails active harness hooks without local binding", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(
      join(cwd, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "saga ingest codex-hook", type: "command" }] }],
        },
      }),
    );

    const checks = await doctorProject({ cwd });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "divergent; Saga hooks are partially installed but local binding is missing; activation: missing-binding; workspace binding is missing; run saga init; next step: run saga init and saga harness install codex before checking activation",
        label: "harness:codex",
        status: "fail",
      }),
    );
  });

  test("warns when Codex hooks are installed but trust is pending", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    const hostId = "host-id";
    const shimPath = join(cwd, ".codex", "saga-codex-hook.sh");
    const hooksPath = join(cwd, ".codex", "hooks.json");
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(
      join(cwd, ".saga.local.json"),
      JSON.stringify({
        harnesses: {
          codex: {
            hookCommand: `'${shimPath}'`,
            hookTrust: "requires-review",
            hooksPath,
            installedAt: new Date().toISOString(),
            sourceBindingId: "codex-source-id",
            sourceUri: `codex://host/${hostId}`,
            target: "codex",
          },
        },
        host: {
          id: hostId,
          label: "test-host",
        },
        project: {
          root: cwd,
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
      }),
    );
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: "command" }] }],
          Stop: [{ hooks: [{ command: shimPath, type: "command" }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: "command" }] }],
        },
      }),
    );

    const checks = await doctorProject({
      cwd,
      verifyHarnessActivation: async () => noEvidenceActivation(),
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "pending-trust; binding and hooks are installed, but no Codex SessionStart/UserPromptSubmit raw_events found for this workspace source binding in the last 24h; activation: no-evidence; no Codex SessionStart/UserPromptSubmit raw_events found for this workspace source binding in the last 24h; next step: approve Codex project-local hooks if prompted, restart Codex or start a new Codex session in this workspace, submit a prompt, then run saga harness status codex again",
        label: "harness:codex",
        status: "warn",
      }),
    );
  });

  test("passes Codex harness when activation evidence proves trusted hooks are executing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    const hostId = "host-id";
    const shimPath = join(cwd, ".codex", "saga-codex-hook.sh");
    const hooksPath = join(cwd, ".codex", "hooks.json");
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(
      join(cwd, ".saga.local.json"),
      JSON.stringify({
        harnesses: {
          codex: {
            hookCommand: `'${shimPath}'`,
            hookTrust: "requires-review",
            hooksPath,
            installedAt: new Date().toISOString(),
            sourceBindingId: "codex-source-id",
            sourceUri: `codex://host/${hostId}`,
            target: "codex",
          },
        },
        host: {
          id: hostId,
          label: "test-host",
        },
        project: {
          root: cwd,
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
      }),
    );
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: "command" }] }],
          Stop: [{ hooks: [{ command: shimPath, type: "command" }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: "command" }] }],
        },
      }),
    );

    const checks = await doctorProject({
      cwd,
      verifyHarnessActivation: async () => activeActivation(),
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "configured; binding and hooks are installed; recent Codex hook raw_event found: codex.UserPromptSubmit at 2026-06-22T11:15:00.000Z; SessionStart sources observed: startup; unproven: resume, clear, compact; activation: active; recent Codex hook raw_event found: codex.UserPromptSubmit at 2026-06-22T11:15:00.000Z; SessionStart sources observed: startup; unproven: resume, clear, compact",
        label: "harness:codex",
        status: "ok",
      }),
    );
  });

  test("fails stale Codex harness state even when activation evidence is active", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    const shimPath = join(cwd, ".codex", "saga-codex-hook.sh");
    const hooksPath = join(cwd, ".codex", "hooks.json");
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(
      join(cwd, ".saga.local.json"),
      JSON.stringify({
        harnesses: {
          codex: {
            hookCommand: `'${shimPath}'`,
            hookTrust: "requires-review",
            hooksPath,
            installedAt: new Date().toISOString(),
            sourceBindingId: "codex-source-id",
            sourceUri: "codex://local",
            target: "codex",
          },
        },
        project: {
          root: cwd,
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
      }),
    );
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: "command" }] }],
          Stop: [{ hooks: [{ command: shimPath, type: "command" }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: "command" }] }],
        },
      }),
    );

    const checks = await doctorProject({
      cwd,
      verifyHarnessActivation: async () => activeActivation(),
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "stale; local binding host id is missing; activation: active; recent Codex hook raw_event found: codex.UserPromptSubmit at 2026-06-22T11:15:00.000Z; SessionStart sources observed: startup; unproven: resume, clear, compact",
        label: "harness:codex",
        status: "fail",
      }),
    );
  });

  test("fails Codex harness when SessionStart matcher misses continuation sources", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    const hostId = "host-id";
    const shimPath = join(cwd, ".codex", "saga-codex-hook.sh");
    const hooksPath = join(cwd, ".codex", "hooks.json");
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(
      join(cwd, ".saga.local.json"),
      JSON.stringify({
        harnesses: {
          codex: {
            hookCommand: `'${shimPath}'`,
            hookTrust: "requires-review",
            hooksPath,
            installedAt: new Date().toISOString(),
            sourceBindingId: "codex-source-id",
            sourceUri: `codex://host/${hostId}`,
            target: "codex",
          },
        },
        host: {
          id: hostId,
          label: "test-host",
        },
        project: {
          root: cwd,
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
      }),
    );
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume",
              hooks: [{ command: shimPath, type: "command" }],
            },
          ],
          Stop: [{ hooks: [{ command: shimPath, type: "command" }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: "command" }] }],
        },
      }),
    );

    const checks = await doctorProject({
      cwd,
      verifyHarnessActivation: async () => noEvidenceActivation(),
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "divergent; local binding exists but SessionStart sources configured: startup, resume; missing: clear, compact; activation: no-evidence; no Codex SessionStart/UserPromptSubmit raw_events found for this workspace source binding in the last 24h; next step: approve Codex project-local hooks if prompted, restart Codex or start a new Codex session in this workspace, submit a prompt, then run saga harness status codex again",
        label: "harness:codex",
        status: "fail",
      }),
    );
  });

  test("fails malformed harness binding even when hooks are active", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(
      join(cwd, ".saga.local.json"),
      JSON.stringify({
        harnesses: {
          codex: {
            hookCommand: `'${join(cwd, ".codex", "saga-codex-hook.sh")}'`,
            hookTrust: "requires-review",
            hooksPath: join(cwd, ".codex", "hooks.json"),
            installedAt: new Date().toISOString(),
            sourceBindingId: "",
            sourceUri: "codex://local",
            target: "codex",
          },
        },
        project: {
          root: cwd,
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
      }),
    );
    writeFileSync(
      join(cwd, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: "saga ingest codex-hook", type: "command" }] }],
          Stop: [{ hooks: [{ command: "saga ingest codex-hook", type: "command" }] }],
          UserPromptSubmit: [{ hooks: [{ command: "saga ingest codex-hook", type: "command" }] }],
        },
      }),
    );

    const checks = await doctorProject({
      cwd,
      verifyHarnessActivation: async () => noEvidenceActivation(),
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail:
          "invalid; invalid harness binding: sourceBindingId must be a non-empty string; activation: no-evidence; no Codex SessionStart/UserPromptSubmit raw_events found for this workspace source binding in the last 24h; next step: approve Codex project-local hooks if prompted, restart Codex or start a new Codex session in this workspace, submit a prompt, then run saga harness status codex again",
        label: "harness:codex",
        status: "fail",
      }),
    );
  });

  test("reports invalid binding files as binding failures", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));
    writeFileSync(join(cwd, ".saga.local.json"), "not json");

    const checks = await doctorProject({ cwd });

    expect(checks).toContainEqual(
      expect.objectContaining({
        label: "binding",
        status: "fail",
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        label: "harness",
        status: "fail",
      }),
    );
  });
});

describe("engine checks", () => {
  test("evaluates the root Node engine range", () => {
    expect(checkNodeVersion(workspaceRoot, "23.9.0")).toMatchObject({
      label: "node",
      status: "fail",
    });
    expect(checkNodeVersion(workspaceRoot, "24.0.0")).toMatchObject({
      label: "node",
      status: "ok",
    });
    expect(checkNodeVersion(workspaceRoot, "27.0.0")).toMatchObject({
      label: "node",
      status: "fail",
    });
  });

  test("evaluates caret engine ranges", () => {
    expect(satisfiesEngineRange("11.8.0", "^11.0.0")).toBe(true);
    expect(satisfiesEngineRange("12.0.0", "^11.0.0")).toBe(false);
  });
});

describe("serviceDoctorStatus", () => {
  test("requires both a running process and healthy service response", () => {
    expect(
      serviceDoctorStatus({
        health: "unreachable (connection refused)",
        process: "running",
      }),
    ).toBe("warn");
    expect(
      serviceDoctorStatus({
        health: "ok (http://127.0.0.1:4766/health)",
        process: "running",
      }),
    ).toBe("ok");
  });
});

function activeActivation(): HarnessActivationStatus {
  return {
    checkedAt: "2026-06-22T12:00:00.000Z",
    detail:
      "recent Codex hook raw_event found: codex.UserPromptSubmit at 2026-06-22T11:15:00.000Z; SessionStart sources observed: startup; unproven: resume, clear, compact",
    lastEvent: {
      eventType: "codex.UserPromptSubmit",
      occurredAt: "2026-06-22T11:15:00.000Z",
    },
    recentWithinHours: 24,
    sessionStartSources: {
      observed: ["startup"],
      unproven: ["resume", "clear", "compact"],
    },
    state: "active",
  };
}

function noEvidenceActivation(): HarnessActivationStatus {
  return {
    checkedAt: "2026-06-22T12:00:00.000Z",
    detail:
      "no Codex SessionStart/UserPromptSubmit raw_events found for this workspace source binding in the last 24h",
    nextStep:
      "approve Codex project-local hooks if prompted, restart Codex or start a new Codex session in this workspace, submit a prompt, then run saga harness status codex again",
    recentWithinHours: 24,
    sessionStartSources: {
      observed: [],
      unproven: ["startup", "resume", "clear", "compact"],
    },
    state: "no-evidence",
  };
}
