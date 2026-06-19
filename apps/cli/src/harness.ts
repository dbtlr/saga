import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMigrationsCurrent, makeDatabase, registerSourceBinding } from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";
import { findProjectRoot, readBindingFile, writeBindingFile } from "./init.js";

export type HarnessTarget = "codex" | "claude";

export interface CodexHarnessStatus {
  binding: "installed" | "missing";
  hookCommand: string;
  hookTrust: "not installed" | "requires review";
  hooks: "installed" | "invalid" | "missing";
  hooksError?: string;
  hooksPath: string;
  mcp: "deferred";
  target: "codex";
}

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

interface CodexHooksFile {
  hooks?: Record<string, HookMatcher[]>;
}

interface CodexHooksParseError {
  message: string;
  path: string;
}

type CodexHooksReadResult =
  | { file: CodexHooksFile; ok: true }
  | { error: CodexHooksParseError; ok: false };

const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
const LEGACY_CODEX_HOOK_COMMAND = "saga ingest codex-hook";
const CODEX_HOOK_SCRIPT = "saga-codex-hook.sh";
const CODEX_SOURCE_URI = "codex://local";
const CODEX_HOOK_TIMEOUT_SECONDS = 30;

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
  registerCodexSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  target: HarnessTarget;
}): Promise<CodexHarnessStatus> {
  assertCodexTarget(input.target);
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error(`run saga init before installing the ${input.target} harness`);
  }

  const codexSourceBinding = await (input.registerCodexSource ?? registerCodexSourceBinding)(
    projectRoot,
    binding.workspace.id,
  );
  const hooksPath = codexHooksPath(projectRoot);
  const hookCommand = codexHookShimCommand(projectRoot);
  const hooksFile = readCodexHooksFile(hooksPath);

  const installedAt = new Date().toISOString();
  writeBindingFile(projectRoot, {
    ...binding,
    harnesses: {
      ...binding.harnesses,
      codex: {
        hookCommand,
        hookTrust: "requires-review",
        hooksPath,
        installedAt,
        sourceBindingId: codexSourceBinding.id,
        sourceUri: CODEX_SOURCE_URI,
        target: "codex",
      },
    },
  });

  ensureGitignoreEntry(projectRoot, ".codex/");
  installCodexHookShim(projectRoot);
  writeJsonFile(hooksPath, installSagaCodexHooks(hooksFile, hookCommand));

  return inspectCodexHarness(projectRoot);
}

export function uninstallHarness(input: {
  cwd?: string;
  target: HarnessTarget;
}): CodexHarnessStatus {
  assertCodexTarget(input.target);
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  const hooksPath = codexHooksPath(projectRoot);

  if (existsSync(hooksPath)) {
    const hooksFile = readCodexHooksFile(hooksPath);
    writeJsonFile(
      hooksPath,
      uninstallSagaCodexHooks(hooksFile, binding?.harnesses?.codex?.hookCommand),
    );
  }

  if (binding !== undefined) {
    const { codex: _codex, ...restHarnesses } = binding.harnesses ?? {};
    const { harnesses: _harnesses, ...bindingWithoutHarnesses } = binding;
    const nextBinding = {
      ...bindingWithoutHarnesses,
      ...(Object.keys(restHarnesses).length > 0 ? { harnesses: restHarnesses } : {}),
    };
    writeBindingFile(projectRoot, nextBinding);
  }

  return inspectCodexHarness(projectRoot);
}

export function inspectHarness(input: { cwd?: string; target: HarnessTarget }): CodexHarnessStatus {
  assertCodexTarget(input.target);
  return inspectCodexHarness(findProjectRoot(input.cwd ?? process.cwd()));
}

function inspectCodexHarness(projectRoot: string): CodexHarnessStatus {
  const hooksPath = codexHooksPath(projectRoot);
  const binding = readBindingFile(projectRoot);
  const hookCommand = binding?.harnesses?.codex?.hookCommand ?? codexHookShimCommand(projectRoot);
  const hooksFile = tryReadCodexHooksFile(hooksPath);
  if (!hooksFile.ok) {
    return {
      binding: binding?.harnesses?.codex === undefined ? "missing" : "installed",
      hookCommand,
      hooks: "invalid",
      hooksError: formatCodexHooksParseError(hooksFile.error),
      hookTrust: "not installed",
      hooksPath,
      mcp: "deferred",
      target: "codex",
    };
  }

  const hooksInstalled = hasSagaCodexHooks(hooksFile.file, hookCommand);
  return {
    binding: binding?.harnesses?.codex === undefined ? "missing" : "installed",
    hookCommand,
    hookTrust: hooksInstalled ? "requires review" : "not installed",
    hooks: hooksInstalled ? "installed" : "missing",
    hooksPath,
    mcp: "deferred",
    target: "codex",
  };
}

function formatHarnessResult(
  title: string,
  status: CodexHarnessStatus,
  options: RenderOptions,
): string {
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

function assertCodexTarget(target: HarnessTarget): asserts target is "codex" {
  if (target !== "codex") {
    throw new Error(`harness ${target} is not implemented yet`);
  }
}

function codexHooksPath(projectRoot: string): string {
  return join(projectRoot, ".codex", "hooks.json");
}

function codexHookShimPath(projectRoot: string): string {
  return join(projectRoot, ".codex", CODEX_HOOK_SCRIPT);
}

function codexHookShimCommand(projectRoot: string): string {
  return quoteShellArg(codexHookShimPath(projectRoot));
}

function installCodexHookShim(projectRoot: string): string {
  const shimPath = codexHookShimPath(projectRoot);
  const cliPath = fileURLToPath(new URL("../bin/saga.js", import.meta.url));
  mkdirSync(dirname(shimPath), { recursive: true });
  writeFileSync(
    shimPath,
    ["#!/bin/sh", `exec ${quoteShellArg(cliPath)} ingest codex-hook "$@"`, ""].join("\n"),
  );
  chmodSync(shimPath, 0o755);
  return quoteShellArg(shimPath);
}

async function registerCodexSourceBinding(projectRoot: string, workspaceId: string) {
  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    await Effect.runPromise(assertMigrationsCurrent(service));
    return await Effect.runPromise(
      registerSourceBinding(service, {
        config: {
          projectRoot,
        },
        displayName: "Codex",
        sourceType: "codex",
        sourceUri: CODEX_SOURCE_URI,
        workspaceId,
      }),
    );
  } finally {
    await Effect.runPromise(service.close());
  }
}

function readCodexHooksFile(path: string): CodexHooksFile {
  const result = tryReadCodexHooksFile(path);
  if (result.ok) return result.file;
  throw new Error(formatCodexHooksParseError(result.error));
}

function tryReadCodexHooksFile(path: string): CodexHooksReadResult {
  if (!existsSync(path)) return { file: {}, ok: true };
  try {
    return { file: parseCodexHooksFile(JSON.parse(readFileSync(path, "utf8"))), ok: true };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        path,
      },
      ok: false,
    };
  }
}

function formatCodexHooksParseError(error: CodexHooksParseError): string {
  return `invalid Codex hooks file ${error.path}: ${error.message}`;
}

function parseCodexHooksFile(value: unknown): CodexHooksFile {
  if (!isRecord(value)) {
    throw new Error("expected a JSON object");
  }

  if (value.hooks === undefined) return value as CodexHooksFile;
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
        if (typeof hook.command !== "string") {
          throw new Error(
            `expected hooks.${event}[${matcherIndex}].hooks[${hookIndex}].command to be a string`,
          );
        }
      }
    }
  }

  return value as CodexHooksFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureGitignoreEntry(projectRoot: string, entry: string): void {
  const gitignorePath = join(projectRoot, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.includes(entry)) return;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, `${existing}${prefix}${entry}\n`);
}

function installSagaCodexHooks(file: CodexHooksFile, hookCommand: string): CodexHooksFile {
  const hooks = { ...file.hooks };
  for (const event of CODEX_HOOK_EVENTS) {
    const matchers = withoutSagaCodexHooks(hooks[event] ?? []);
    matchers.push({
      ...(event === "SessionStart" ? { matcher: "startup|resume|clear|compact" } : {}),
      hooks: [
        {
          command: hookCommand,
          statusMessage: "Syncing Saga workspace memory",
          timeout: CODEX_HOOK_TIMEOUT_SECONDS,
          type: "command",
        },
      ],
    });
    hooks[event] = matchers;
  }
  return { ...file, hooks };
}

function uninstallSagaCodexHooks(
  file: CodexHooksFile,
  hookCommand: string | undefined,
): CodexHooksFile {
  const hooks = { ...file.hooks };
  for (const event of CODEX_HOOK_EVENTS) {
    const matchers = withoutSagaCodexHooks(hooks[event] ?? [], hookCommand);
    if (matchers.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = matchers;
    }
  }
  return { ...file, hooks };
}

function hasSagaCodexHooks(file: CodexHooksFile, hookCommand: string): boolean {
  return CODEX_HOOK_EVENTS.every((event) =>
    (file.hooks?.[event] ?? []).some((matcher) =>
      (matcher.hooks ?? []).some((hook) => hook.command === hookCommand),
    ),
  );
}

function withoutSagaCodexHooks(
  matchers: readonly HookMatcher[],
  hookCommand?: string,
): HookMatcher[] {
  return matchers
    .map((matcher) => ({
      ...matcher,
      hooks: (matcher.hooks ?? []).filter(
        (hook) =>
          hook.command !== hookCommand &&
          hook.command !== LEGACY_CODEX_HOOK_COMMAND &&
          !hook.command.endsWith(`/.codex/${CODEX_HOOK_SCRIPT}`) &&
          !hook.command.endsWith(`/.codex/${CODEX_HOOK_SCRIPT}'`) &&
          !hook.command.endsWith(`/.codex/${CODEX_HOOK_SCRIPT}"`),
      ),
    }))
    .filter((matcher) => (matcher.hooks ?? []).length > 0);
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function relativeHooksPath(projectRoot: string, hooksPath: string): string {
  return relative(projectRoot, hooksPath);
}
