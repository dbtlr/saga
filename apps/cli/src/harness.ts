import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";
import { findProjectRoot, readBindingFile, writeBindingFile } from "./init.js";

export type HarnessTarget = "codex" | "claude";

export interface CodexHarnessStatus {
  binding: "installed" | "missing";
  hookCommand: string;
  hooks: "installed" | "missing";
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

const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
const CODEX_HOOK_COMMAND = "saga ingest codex-hook";
const CODEX_HOOK_TIMEOUT_SECONDS = 30;

export async function runHarnessCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];
  const target = parseTarget(args[1]);

  if (subcommand === "install") {
    const result = installHarness({ target });
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

export function installHarness(input: {
  cwd?: string;
  target: HarnessTarget;
}): CodexHarnessStatus {
  assertCodexTarget(input.target);
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  if (binding === undefined) {
    throw new Error(`run saga init before installing the ${input.target} harness`);
  }

  const hooksPath = codexHooksPath(projectRoot);
  const hooksFile = readCodexHooksFile(hooksPath);
  const nextHooksFile = installSagaCodexHooks(hooksFile);
  writeJsonFile(hooksPath, nextHooksFile);
  ensureGitignoreEntry(projectRoot, ".codex/");

  const installedAt = new Date().toISOString();
  writeBindingFile(projectRoot, {
    ...binding,
    harnesses: {
      ...binding.harnesses,
      codex: {
        hookCommand: CODEX_HOOK_COMMAND,
        hooksPath,
        installedAt,
        target: "codex",
      },
    },
  });

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
    writeJsonFile(hooksPath, uninstallSagaCodexHooks(readCodexHooksFile(hooksPath)));
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

export function inspectHarness(input: {
  cwd?: string;
  target: HarnessTarget;
}): CodexHarnessStatus {
  assertCodexTarget(input.target);
  return inspectCodexHarness(findProjectRoot(input.cwd ?? process.cwd()));
}

function inspectCodexHarness(projectRoot: string): CodexHarnessStatus {
  const hooksPath = codexHooksPath(projectRoot);
  const binding = readBindingFile(projectRoot);
  return {
    binding: binding?.harnesses?.codex === undefined ? "missing" : "installed",
    hookCommand: CODEX_HOOK_COMMAND,
    hooks: hasSagaCodexHooks(readCodexHooksFile(hooksPath)) ? "installed" : "missing",
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

function readCodexHooksFile(path: string): CodexHooksFile {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as CodexHooksFile;
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

function installSagaCodexHooks(file: CodexHooksFile): CodexHooksFile {
  const hooks = { ...(file.hooks ?? {}) };
  for (const event of CODEX_HOOK_EVENTS) {
    const matchers = withoutSagaCodexHooks(hooks[event] ?? []);
    matchers.push({
      ...(event === "SessionStart" ? { matcher: "startup|resume|clear|compact" } : {}),
      hooks: [
        {
          command: CODEX_HOOK_COMMAND,
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

function uninstallSagaCodexHooks(file: CodexHooksFile): CodexHooksFile {
  const hooks = { ...(file.hooks ?? {}) };
  for (const event of CODEX_HOOK_EVENTS) {
    const matchers = withoutSagaCodexHooks(hooks[event] ?? []);
    if (matchers.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = matchers;
    }
  }
  return { ...file, hooks };
}

function hasSagaCodexHooks(file: CodexHooksFile): boolean {
  return CODEX_HOOK_EVENTS.every((event) =>
    (file.hooks?.[event] ?? []).some((matcher) =>
      (matcher.hooks ?? []).some((hook) => hook.command === CODEX_HOOK_COMMAND),
    ),
  );
}

function withoutSagaCodexHooks(matchers: readonly HookMatcher[]): HookMatcher[] {
  return matchers
    .map((matcher) => ({
      ...matcher,
      hooks: (matcher.hooks ?? []).filter((hook) => hook.command !== CODEX_HOOK_COMMAND),
    }))
    .filter((matcher) => (matcher.hooks ?? []).length > 0);
}

export function relativeHooksPath(projectRoot: string, hooksPath: string): string {
  return relative(projectRoot, hooksPath);
}
