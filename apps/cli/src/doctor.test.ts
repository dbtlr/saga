import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { doctorProject, renderDoctor, runDoctor, type DoctorCheck } from "./doctor.js";

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
  test("reports harness target states", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "saga-doctor-"));

    const checks = await doctorProject({ cwd });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail: "missing; binding and hooks are not installed",
        label: "harness:codex",
        status: "warn",
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        detail: "missing; binding and hooks are not installed",
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
        detail: "divergent; Saga hooks are partially installed but local binding is missing",
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

    const checks = await doctorProject({ cwd });

    expect(checks).toContainEqual(
      expect.objectContaining({
        detail: "invalid; invalid harness binding: sourceBindingId must be a non-empty string",
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
