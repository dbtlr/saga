import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  installHarness,
  inspectHarness,
  listHarnessAdapters,
  uninstallHarness,
} from "./harness.js";
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

describe("listHarnessAdapters", () => {
  test("describes the supported harness targets", () => {
    const projectRoot = "/workspace";

    expect(
      listHarnessAdapters().map((adapter) => ({
        hooksPath: adapter.hooksPath(projectRoot),
        ingestCommand: adapter.ingestCommand,
        sourceUri: adapter.sourceUri,
        target: adapter.target,
      })),
    ).toEqual([
      {
        hooksPath: join(projectRoot, ".codex", "hooks.json"),
        ingestCommand: "codex-hook",
        sourceUri: "codex://local",
        target: "codex",
      },
      {
        hooksPath: join(projectRoot, ".claude", "settings.local.json"),
        ingestCommand: "claude-hook",
        sourceUri: "claude://local",
        target: "claude",
      },
    ]);
  });
});

describe("installHarness", () => {
  test("installs Codex hooks and records local harness state", async () => {
    const projectRoot = boundProject();

    const status = await installHarness({
      cwd: projectRoot,
      registerCodexSource: async () => ({ id: "codex-source-id" }),
      target: "codex",
    });

    expect(status.binding).toBe("installed");
    expect(status.hooks).toBe("installed");
    expect(status.hookTrust).toBe("requires review");
    expect(status.hooksPath).toBe(join(projectRoot, ".codex", "hooks.json"));
    const binding = readBindingFile(projectRoot);
    expect(binding?.harnesses?.codex?.sourceBindingId).toBe("codex-source-id");
    expect(binding?.harnesses?.codex?.hookTrust).toBe("requires-review");
    expect(readFileSync(join(projectRoot, ".gitignore"), "utf8")).toContain(".codex/\n");

    const hooks = JSON.parse(readFileSync(status.hooksPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(hooks.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toBe(status.hookCommand);

    const commandCheck = spawnSync("/bin/sh", [
      "-n",
      join(projectRoot, ".codex", "saga-codex-hook.sh"),
    ]);
    expect(commandCheck.status).toBe(0);
  });

  test("installs Claude Code hooks and records local harness state", async () => {
    const projectRoot = boundProject();

    const status = await installHarness({
      cwd: projectRoot,
      registerClaudeSource: async () => ({ id: "claude-source-id" }),
      target: "claude",
    });

    expect(status.binding).toBe("installed");
    expect(status.hooks).toBe("installed");
    expect(status.hookTrust).toBe("requires review");
    expect(status.hooksPath).toBe(join(projectRoot, ".claude", "settings.local.json"));
    expect(status.skills).toBe("deferred");
    const binding = readBindingFile(projectRoot);
    expect(binding?.harnesses?.claude?.sourceBindingId).toBe("claude-source-id");
    expect(binding?.harnesses?.claude?.sourceUri).toBe("claude://local");
    expect(readFileSync(join(projectRoot, ".gitignore"), "utf8")).toContain(
      ".claude/settings.local.json\n",
    );
    expect(readFileSync(join(projectRoot, ".gitignore"), "utf8")).toContain(
      ".claude/saga-claude-hook.sh\n",
    );

    const settings = JSON.parse(readFileSync(status.hooksPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(status.hookCommand);

    const commandCheck = spawnSync("/bin/sh", [
      "-n",
      join(projectRoot, ".claude", "saga-claude-hook.sh"),
    ]);
    expect(commandCheck.status).toBe(0);
  });

  test("preserves non-Saga Codex hooks", async () => {
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

    await installHarness({
      cwd: projectRoot,
      registerCodexSource: async () => ({ id: "codex-source-id" }),
      target: "codex",
    });
    uninstallHarness({ cwd: projectRoot, target: "codex" });

    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: { Stop?: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toBe("echo keep");
    expect(inspectHarness({ cwd: projectRoot, target: "codex" }).hooks).toBe("missing");
    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test("preserves non-Saga Claude hooks", async () => {
    const projectRoot = boundProject();
    const settingsPath = join(projectRoot, ".claude", "settings.local.json");
    mkdirSync(join(projectRoot, ".claude"));
    writeFileSync(
      settingsPath,
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

    await installHarness({
      cwd: projectRoot,
      registerClaudeSource: async () => ({ id: "claude-source-id" }),
      target: "claude",
    });
    uninstallHarness({ cwd: projectRoot, target: "claude" });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { Stop?: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe("echo keep");
    expect(inspectHarness({ cwd: projectRoot, target: "claude" }).hooks).toBe("missing");
    expect(readBindingFile(projectRoot)?.harnesses?.claude).toBeUndefined();
  });

  test("preserves valid non-command Claude hooks", async () => {
    const projectRoot = boundProject();
    const settingsPath = join(projectRoot, ".claude", "settings.local.json");
    mkdirSync(join(projectRoot, ".claude"));
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { prompt: "Summarize the session", type: "prompt" },
                { server: "memory", tool: "store", type: "mcp_tool" },
                { prompt: "Inspect this event", type: "agent" },
                { type: "http", url: "https://example.invalid/hook" },
              ],
            },
          ],
        },
      })}\n`,
    );

    await installHarness({
      cwd: projectRoot,
      registerClaudeSource: async () => ({ id: "claude-source-id" }),
      target: "claude",
    });
    uninstallHarness({ cwd: projectRoot, target: "claude" });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { Stop?: Array<{ hooks: Array<{ type: string }> }> };
    };
    expect(settings.hooks.Stop?.[0]?.hooks.map((hook) => hook.type)).toEqual([
      "prompt",
      "mcp_tool",
      "agent",
      "http",
    ]);
  });

  test("requires saga init first", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "saga-harness-missing-"));

    await expect(installHarness({ cwd: projectRoot, target: "codex" })).rejects.toThrow(
      "run saga init before installing the codex harness",
    );
  });

  test("does not write active hooks when Codex source registration fails", async () => {
    const projectRoot = boundProject();

    await expect(
      installHarness({
        cwd: projectRoot,
        registerCodexSource: async () => {
          throw new Error("database unavailable");
        },
        target: "codex",
      }),
    ).rejects.toThrow("database unavailable");

    expect(existsSync(join(projectRoot, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(projectRoot, ".codex", "saga-codex-hook.sh"))).toBe(false);
    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test("does not write active hooks when database migrations are stale", async () => {
    const projectRoot = boundProject();

    await expect(
      installHarness({
        cwd: projectRoot,
        registerCodexSource: async () => {
          throw new Error("database migrations are not current: 2 applied; expected 3");
        },
        target: "codex",
      }),
    ).rejects.toThrow("database migrations are not current");

    expect(existsSync(join(projectRoot, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(projectRoot, ".codex", "saga-codex-hook.sh"))).toBe(false);
    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test("rolls back local binding when hook activation dependencies fail", async () => {
    const projectRoot = boundProject();
    mkdirSync(join(projectRoot, ".gitignore"));

    await expect(
      installHarness({
        cwd: projectRoot,
        registerCodexSource: async () => ({ id: "codex-source-id" }),
        target: "codex",
      }),
    ).rejects.toThrow();

    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
    expect(existsSync(join(projectRoot, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(projectRoot, ".codex", "saga-codex-hook.sh"))).toBe(false);
  });

  test("rejects shape-invalid Codex hooks config before recording local harness state", async () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    mkdirSync(join(projectRoot, ".codex"));
    writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: {} } }));

    await expect(
      installHarness({
        cwd: projectRoot,
        registerCodexSource: async () => ({ id: "codex-source-id" }),
        target: "codex",
      }),
    ).rejects.toThrow(`invalid Codex hooks file ${hooksPath}: expected hooks.Stop to be an array`);

    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test("validates hook settings before registering source bindings", async () => {
    const projectRoot = boundProject();
    const settingsPath = join(projectRoot, ".claude", "settings.local.json");
    mkdirSync(join(projectRoot, ".claude"));
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: {} } }));
    let registered = false;

    await expect(
      installHarness({
        cwd: projectRoot,
        registerClaudeSource: async () => {
          registered = true;
          return { id: "claude-source-id" };
        },
        target: "claude",
      }),
    ).rejects.toThrow(
      `invalid Claude settings file ${settingsPath}: expected hooks.Stop to be an array`,
    );

    expect(registered).toBe(false);
    expect(readBindingFile(projectRoot)?.harnesses?.claude).toBeUndefined();
  });
});

describe("inspectHarness", () => {
  test("reports malformed Codex hooks config", () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    mkdirSync(join(projectRoot, ".codex"));
    writeFileSync(hooksPath, "{invalid-json");

    const status = inspectHarness({ cwd: projectRoot, target: "codex" });

    expect(status.hooks).toBe("invalid");
    expect(status.hookTrust).toBe("not installed");
    expect(status.hooksError).toContain(`invalid Codex hooks file ${hooksPath}:`);
  });

  test("reports shape-invalid Codex hooks config", () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    mkdirSync(join(projectRoot, ".codex"));
    writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: {} } }));

    const status = inspectHarness({ cwd: projectRoot, target: "codex" });

    expect(status.hooks).toBe("invalid");
    expect(status.hooksError).toBe(
      `invalid Codex hooks file ${hooksPath}: expected hooks.Stop to be an array`,
    );
  });
});

describe("uninstallHarness", () => {
  test("reports malformed Codex hooks config with path", () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    mkdirSync(join(projectRoot, ".codex"));
    writeFileSync(hooksPath, "{invalid-json");

    expect(() => uninstallHarness({ cwd: projectRoot, target: "codex" })).toThrow(
      `invalid Codex hooks file ${hooksPath}:`,
    );
  });

  test("preserves non-command Codex hooks", () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    mkdirSync(join(projectRoot, ".codex"));
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ prompt: "Summarize the session", type: "prompt" }],
            },
          ],
        },
      }),
    );

    uninstallHarness({ cwd: projectRoot, target: "codex" });

    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: { Stop?: Array<{ hooks: Array<{ type: string }> }> };
    };
    expect(hooks.hooks.Stop?.[0]?.hooks.map((hook) => hook.type)).toEqual(["prompt"]);
  });
});
