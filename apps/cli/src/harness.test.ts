import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { installHarness, inspectHarness, uninstallHarness } from "./harness.js";
import { readBindingFile, writeBindingFile } from "./init.js";

function boundProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "saga-harness-"));
  writeBindingFile(projectRoot, {
    project: {
      gitRemote: undefined,
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
  return projectRoot;
}

describe("installHarness", () => {
  test("installs Codex hooks and records local harness state", () => {
    const projectRoot = boundProject();

    const status = installHarness({ cwd: projectRoot, target: "codex" });

    expect(status.binding).toBe("installed");
    expect(status.hooks).toBe("installed");
    expect(status.hooksPath).toBe(join(projectRoot, ".codex", "hooks.json"));
    expect(readBindingFile(projectRoot)?.harnesses?.codex?.hookCommand).toBe(
      "saga ingest codex-hook",
    );
    expect(readFileSync(join(projectRoot, ".gitignore"), "utf8")).toContain(".codex/\n");

    const hooks = JSON.parse(readFileSync(status.hooksPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(hooks.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("saga ingest codex-hook");
    expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe("saga ingest codex-hook");
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toBe("saga ingest codex-hook");
  });

  test("preserves non-Saga Codex hooks", () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    mkdirSync(join(projectRoot, ".codex"));
    writeFileSync(
      hooksPath,
      `${JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ command: "echo keep", type: "command" }],
            },
          ],
        },
      })}\n`,
    );

    installHarness({ cwd: projectRoot, target: "codex" });
    uninstallHarness({ cwd: projectRoot, target: "codex" });

    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: { Stop?: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toBe("echo keep");
    expect(inspectHarness({ cwd: projectRoot, target: "codex" }).hooks).toBe("missing");
    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test("requires saga init first", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "saga-harness-missing-"));

    expect(() => installHarness({ cwd: projectRoot, target: "codex" })).toThrow(
      "run saga init before installing the codex harness",
    );
  });

  test("rejects unsupported targets", () => {
    const projectRoot = boundProject();

    expect(() => installHarness({ cwd: projectRoot, target: "claude" })).toThrow(
      "harness claude is not implemented yet",
    );
  });
});
