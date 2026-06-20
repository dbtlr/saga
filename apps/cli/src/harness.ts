import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMigrationsCurrent, makeDatabase, registerSourceBinding } from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";
import {
  findProjectRoot,
  readBindingFile,
  writeBindingFile,
  type WorkspaceBindingFile,
} from "./init.js";

export type HarnessTarget = "codex" | "claude";

export interface HarnessStatus {
  binding: "installed" | "missing";
  hookCommand: string;
  hookTrust: "not installed" | "requires review";
  hooks: "installed" | "invalid" | "missing";
  hooksError?: string;
  hooksPath: string;
  mcp: "deferred";
  skills: "deferred";
  target: HarnessTarget;
}

export type CodexHarnessStatus = HarnessStatus & { target: "codex" };

interface HookCommand {
  command: string;
  statusMessage?: string;
  timeout?: number;
  type: "command";
}

interface HookMatcher {
  hooks?: HookCommand[];
  matcher?: string;
}

interface HooksSettingsFile {
  hooks?: Record<string, HookMatcher[]>;
}

interface HooksSettingsParseError {
  message: string;
  path: string;
  target: HarnessTarget;
}

type HooksSettingsReadResult =
  | { file: HooksSettingsFile; ok: true }
  | { error: HooksSettingsParseError; ok: false };

const HARNESS_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
const LEGACY_HOOK_COMMANDS = {
  claude: "saga ingest claude-hook",
  codex: "saga ingest codex-hook",
} as const;
const LEGACY_CODEX_HOOK_COMMAND = "saga ingest codex-hook";
const HOOK_SCRIPTS = {
  claude: "saga-claude-hook.sh",
  codex: "saga-codex-hook.sh",
} as const;
const SOURCE_URIS = {
  claude: "claude://local",
  codex: "codex://local",
} as const;
const SOURCE_DISPLAY_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
} as const;
const HOOK_TIMEOUT_SECONDS = 30;

export async function runHarnessCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];
  const target = parseTarget(args[1]);

  if (subcommand === "install") {
    const result = await installHarness({ target });
    return formatHarnessResult("Harness installed", result, options);
  }

  if (subcommand === "uninstall") {
    const result = uninstallHarness({ target });
    return formatHarnessResult("Harness uninstalled", result, options);
  }

  if (subcommand === "status") {
    const result = inspectHarness({ target });
    return formatHarnessResult("Harness status", result, options);
  }

  throw new Error(`harness ${subcommand ?? ""} is not implemented yet`.trim());
}

export async function installHarness(input: {
  cwd?: string;
  registerClaudeSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  registerCodexSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  target: HarnessTarget;
}): Promise<HarnessStatus> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error(`run saga init before installing the ${input.target} harness`);
  }

  const hooksPath = harnessHooksPath(projectRoot, input.target);
  const hookCommand = hookShimCommand(projectRoot, input.target);
  const hooksFile = readHooksSettingsFile(hooksPath, input.target);
  const sourceBinding = await registerHarnessSourceBinding(input)(
    projectRoot,
    binding.workspace.id,
  );

  const installedAt = new Date().toISOString();
  const nextBinding: WorkspaceBindingFile = {
    ...binding,
    harnesses: {
      ...binding.harnesses,
      [input.target]: {
        hookCommand,
        hookTrust: "requires-review",
        hooksPath,
        installedAt,
        sourceBindingId: sourceBinding.id,
        sourceUri: SOURCE_URIS[input.target],
        target: input.target,
      },
    },
  };

  writeBindingFile(projectRoot, nextBinding);
  try {
    ensureGitignoreEntry(projectRoot, gitignoreEntriesForTarget(input.target));
    installHookShim(projectRoot, input.target);
    writeJsonFile(hooksPath, installSagaHooks(hooksFile, hookCommand));
  } catch (error) {
    writeBindingFile(projectRoot, binding);
    throw error;
  }

  return inspectHarness({ cwd: projectRoot, target: input.target });
}

export function uninstallHarness(input: { cwd?: string; target: HarnessTarget }): HarnessStatus {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  const hooksPath = harnessHooksPath(projectRoot, input.target);

  if (existsSync(hooksPath)) {
    const hooksFile = readHooksSettingsFile(hooksPath, input.target);
    writeJsonFile(
      hooksPath,
      uninstallSagaHooks(hooksFile, binding?.harnesses?.[input.target]?.hookCommand, input.target),
    );
  }

  if (binding !== undefined) {
    const { [input.target]: _target, ...restHarnesses } = binding.harnesses ?? {};
    const { harnesses: _harnesses, ...bindingWithoutHarnesses } = binding;
    const nextBinding = {
      ...bindingWithoutHarnesses,
      ...(Object.keys(restHarnesses).length > 0 ? { harnesses: restHarnesses } : {}),
    };
    writeBindingFile(projectRoot, nextBinding);
  }

  return inspectHarness({ cwd: projectRoot, target: input.target });
}

export function inspectHarness(input: { cwd?: string; target: HarnessTarget }): HarnessStatus {
  return inspectTargetHarness(findProjectRoot(input.cwd ?? process.cwd()), input.target);
}

function inspectTargetHarness(projectRoot: string, target: HarnessTarget): HarnessStatus {
  const hooksPath = harnessHooksPath(projectRoot, target);
  const binding = readBindingFile(projectRoot);
  const hookCommand =
    binding?.harnesses?.[target]?.hookCommand ?? hookShimCommand(projectRoot, target);
  const hooksFile = tryReadHooksSettingsFile(hooksPath, target);
  if (!hooksFile.ok) {
    return {
      binding: binding?.harnesses?.[target] === undefined ? "missing" : "installed",
      hookCommand,
      hooks: "invalid",
      hooksError: formatHooksSettingsParseError(hooksFile.error),
      hookTrust: "not installed",
      hooksPath,
      mcp: "deferred",
      skills: "deferred",
      target,
    };
  }

  const hooksInstalled = hasSagaHooks(hooksFile.file, hookCommand);
  return {
    binding: binding?.harnesses?.[target] === undefined ? "missing" : "installed",
    hookCommand,
    hookTrust: hooksInstalled ? "requires review" : "not installed",
    hooks: hooksInstalled ? "installed" : "missing",
    hooksPath,
    mcp: "deferred",
    skills: "deferred",
    target,
  };
}

function formatHarnessResult(title: string, status: HarnessStatus, options: RenderOptions): string {
  return formatCommandOutput(
    {
      id: status.target,
      records: recordBlock(
        title,
        [
          { label: "target", value: status.target },
          { label: "binding", value: status.binding },
          { label: "hooks", value: status.hooks },
          ...(status.hooksError === undefined
            ? []
            : [{ label: "hooks error", value: status.hooksError }]),
          { label: "hook trust", value: status.hookTrust },
          { label: "hooks path", value: status.hooksPath },
          { label: "hook command", value: status.hookCommand },
          { label: "mcp", value: "deferred until saga mcp is implemented" },
          { label: "skills", value: "deferred until Saga skills are packaged" },
        ],
        options,
      ),
      value: status,
    },
    options.format,
  );
}

function parseTarget(value: string | undefined): HarnessTarget {
  if (value === "codex" || value === "claude") return value;
  if (value === undefined) throw new Error("harness target is required");
  throw new Error(`unsupported harness target: ${value}`);
}

function harnessHooksPath(projectRoot: string, target: HarnessTarget): string {
  if (target === "claude") return join(projectRoot, ".claude", "settings.local.json");
  return join(projectRoot, ".codex", "hooks.json");
}

function hookShimPath(projectRoot: string, target: HarnessTarget): string {
  return join(projectRoot, target === "claude" ? ".claude" : ".codex", HOOK_SCRIPTS[target]);
}

function hookShimCommand(projectRoot: string, target: HarnessTarget): string {
  return quoteShellArg(hookShimPath(projectRoot, target));
}

function installHookShim(projectRoot: string, target: HarnessTarget): string {
  const shimPath = hookShimPath(projectRoot, target);
  const cliPath = fileURLToPath(new URL("../bin/saga.js", import.meta.url));
  mkdirSync(dirname(shimPath), { recursive: true });
  writeFileSync(
    shimPath,
    ["#!/bin/sh", `exec ${quoteShellArg(cliPath)} ingest ${target}-hook "$@"`, ""].join("\n"),
  );
  chmodSync(shimPath, 0o755);
  return quoteShellArg(shimPath);
}

function gitignoreEntriesForTarget(target: HarnessTarget): string[] {
  if (target === "claude") return [".claude/settings.local.json", ".claude/saga-claude-hook.sh"];
  return [".codex/"];
}

function registerHarnessSourceBinding(input: {
  registerClaudeSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  registerCodexSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  target: HarnessTarget;
}): (projectRoot: string, workspaceId: string) => Promise<{ id: string }> {
  if (input.target === "claude") return input.registerClaudeSource ?? registerClaudeSourceBinding;
  return input.registerCodexSource ?? registerCodexSourceBinding;
}

async function registerClaudeSourceBinding(projectRoot: string, workspaceId: string) {
  return registerAgentSourceBinding(projectRoot, workspaceId, "claude");
}

async function registerCodexSourceBinding(projectRoot: string, workspaceId: string) {
  return registerAgentSourceBinding(projectRoot, workspaceId, "codex");
}

async function registerAgentSourceBinding(
  projectRoot: string,
  workspaceId: string,
  target: HarnessTarget,
) {
  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    await Effect.runPromise(assertMigrationsCurrent(service));
    return await Effect.runPromise(
      registerSourceBinding(service, {
        config: {
          projectRoot,
        },
        displayName: SOURCE_DISPLAY_NAMES[target],
        sourceType: target,
        sourceUri: SOURCE_URIS[target],
        workspaceId,
      }),
    );
  } finally {
    await Effect.runPromise(service.close());
  }
}

function readHooksSettingsFile(path: string, target: HarnessTarget): HooksSettingsFile {
  const result = tryReadHooksSettingsFile(path, target);
  if (result.ok) return result.file;
  throw new Error(formatHooksSettingsParseError(result.error));
}

function tryReadHooksSettingsFile(path: string, target: HarnessTarget): HooksSettingsReadResult {
  if (!existsSync(path)) return { file: {}, ok: true };
  try {
    return { file: parseHooksSettingsFile(JSON.parse(readFileSync(path, "utf8"))), ok: true };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        path,
        target,
      },
      ok: false,
    };
  }
}

function formatHooksSettingsParseError(error: HooksSettingsParseError): string {
  const label = error.target === "claude" ? "Claude settings file" : "Codex hooks file";
  return `invalid ${label} ${error.path}: ${error.message}`;
}

function parseHooksSettingsFile(value: unknown): HooksSettingsFile {
  if (!isRecord(value)) {
    throw new Error("expected a JSON object");
  }

  if (value.hooks === undefined) return value as HooksSettingsFile;
  if (!isRecord(value.hooks)) {
    throw new Error("expected hooks to be an object");
  }

  for (const [event, matchers] of Object.entries(value.hooks)) {
    if (!Array.isArray(matchers)) {
      throw new Error(`expected hooks.${event} to be an array`);
    }

    for (const [matcherIndex, matcher] of matchers.entries()) {
      if (!isRecord(matcher)) {
        throw new Error(`expected hooks.${event}[${matcherIndex}] to be an object`);
      }

      if (matcher.hooks === undefined) continue;
      if (!Array.isArray(matcher.hooks)) {
        throw new Error(`expected hooks.${event}[${matcherIndex}].hooks to be an array`);
      }

      for (const [hookIndex, hook] of matcher.hooks.entries()) {
        if (!isRecord(hook)) {
          throw new Error(
            `expected hooks.${event}[${matcherIndex}].hooks[${hookIndex}] to be an object`,
          );
        }
        if (hook.command !== undefined && typeof hook.command !== "string") {
          throw new Error(
            `expected hooks.${event}[${matcherIndex}].hooks[${hookIndex}].command to be a string`,
          );
        }
      }
    }
  }

  return value as HooksSettingsFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid.toString()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function ensureGitignoreEntry(projectRoot: string, entries: readonly string[]): void {
  const gitignorePath = join(projectRoot, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);
  const missingEntries = entries.filter((entry) => !lines.includes(entry));
  if (missingEntries.length === 0) return;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, `${existing}${prefix}${missingEntries.join("\n")}\n`);
}

function installSagaHooks(file: HooksSettingsFile, hookCommand: string): HooksSettingsFile {
  const hooks = { ...file.hooks };
  for (const event of HARNESS_HOOK_EVENTS) {
    const matchers = withoutSagaHooks(hooks[event] ?? []);
    matchers.push({
      ...(event === "SessionStart" ? { matcher: "startup|resume|clear|compact" } : {}),
      hooks: [
        {
          command: hookCommand,
          statusMessage: "Syncing Saga workspace memory",
          timeout: HOOK_TIMEOUT_SECONDS,
          type: "command",
        },
      ],
    });
    hooks[event] = matchers;
  }
  return { ...file, hooks };
}

function uninstallSagaHooks(
  file: HooksSettingsFile,
  hookCommand: string | undefined,
  target: HarnessTarget,
): HooksSettingsFile {
  const hooks = { ...file.hooks };
  for (const event of HARNESS_HOOK_EVENTS) {
    const matchers = withoutSagaHooks(hooks[event] ?? [], hookCommand, target);
    if (matchers.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = matchers;
    }
  }
  return { ...file, hooks };
}

function hasSagaHooks(file: HooksSettingsFile, hookCommand: string): boolean {
  return HARNESS_HOOK_EVENTS.every((event) =>
    (file.hooks?.[event] ?? []).some((matcher) =>
      (matcher.hooks ?? []).some((hook) => hook.command === hookCommand),
    ),
  );
}

function withoutSagaHooks(
  matchers: readonly HookMatcher[],
  hookCommand?: string,
  target?: HarnessTarget,
): HookMatcher[] {
  const legacyCommands: readonly string[] =
    target === undefined ? Object.values(LEGACY_HOOK_COMMANDS) : [LEGACY_HOOK_COMMANDS[target]];
  const hookScripts: readonly string[] =
    target === undefined ? Object.values(HOOK_SCRIPTS) : [HOOK_SCRIPTS[target]];
  return matchers
    .map((matcher) => {
      if (matcher.hooks === undefined) return matcher;
      return {
        ...matcher,
        hooks: matcher.hooks.filter(
          (hook) => !isSagaHookCommand(hook, hookCommand, legacyCommands, hookScripts),
        ),
      };
    })
    .filter((matcher) => (matcher.hooks ?? []).length > 0);
}

function isSagaHookCommand(
  hook: HookCommand,
  hookCommand: string | undefined,
  legacyCommands: readonly string[],
  hookScripts: readonly string[],
): boolean {
  if (typeof hook.command !== "string") return false;
  return (
    hook.command === hookCommand ||
    hook.command === LEGACY_CODEX_HOOK_COMMAND ||
    legacyCommands.includes(hook.command) ||
    hookScripts.some(
      (script) =>
        hook.command.endsWith(`/${script}`) ||
        hook.command.endsWith(`/${script}'`) ||
        hook.command.endsWith(`/${script}"`),
    )
  );
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function relativeHooksPath(projectRoot: string, hooksPath: string): string {
  return relative(projectRoot, hooksPath);
}
