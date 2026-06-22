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
  ensureLocalHostBinding,
  findProjectRoot,
  readBindingFile,
  writeBindingFile,
  type WorkspaceBindingFile,
} from "./init.js";

export type HarnessTarget = "codex" | "claude";
export type HarnessIntegrationState = "configured" | "divergent" | "invalid" | "missing" | "stale";

export interface HarnessStatus {
  binding: "installed" | "missing";
  displayName: string;
  hookCommand: string;
  hookTrust: "not installed" | "requires review";
  hooksCoverage: "complete" | "partial" | "none";
  hooks: "installed" | "invalid" | "missing";
  hooksError?: string;
  hooksPath: string;
  state: HarnessIntegrationState;
  stateDetail: string;
  mcp: "deferred";
  skills: "deferred";
  target: HarnessTarget;
}

export type CodexHarnessStatus = HarnessStatus & { target: "codex" };

type HarnessSourceUri = `codex://host/${string}` | `claude://host/${string}`;

export interface HarnessAdapter {
  displayName: string;
  gitignoreEntries: readonly string[];
  hooksPath(projectRoot: string): string;
  ingestCommand: "codex-hook" | "claude-hook";
  settingsLabel: string;
  shimScriptName: string;
  shimPath(projectRoot: string): string;
  sourceUri(hostId: string): HarnessSourceUri;
  sourceType: HarnessTarget;
  target: HarnessTarget;
}

interface HarnessBindingSnapshot {
  hookCommand: string;
  hookTrust: string;
  hooksPath: string;
  installedAt: string;
  sourceBindingId: string;
  sourceUri: string;
  target: string;
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
const HOOK_TIMEOUT_SECONDS = 30;
const HARNESS_TARGET_ORDER = ["codex", "claude"] as const satisfies readonly HarnessTarget[];
const HARNESS_ADAPTERS = {
  claude: {
    displayName: "Claude Code",
    gitignoreEntries: [".claude/settings.local.json", ".claude/saga-claude-hook.sh"],
    hooksPath: (projectRoot: string) => join(projectRoot, ".claude", "settings.local.json"),
    ingestCommand: "claude-hook",
    settingsLabel: "Claude settings file",
    shimScriptName: "saga-claude-hook.sh",
    shimPath: (projectRoot: string) => join(projectRoot, ".claude", "saga-claude-hook.sh"),
    sourceUri: (hostId: string) => `claude://host/${hostId}`,
    sourceType: "claude",
    target: "claude",
  },
  codex: {
    displayName: "Codex",
    gitignoreEntries: [".codex/"],
    hooksPath: (projectRoot: string) => join(projectRoot, ".codex", "hooks.json"),
    ingestCommand: "codex-hook",
    settingsLabel: "Codex hooks file",
    shimScriptName: "saga-codex-hook.sh",
    shimPath: (projectRoot: string) => join(projectRoot, ".codex", "saga-codex-hook.sh"),
    sourceUri: (hostId: string) => `codex://host/${hostId}`,
    sourceType: "codex",
    target: "codex",
  },
} as const satisfies Record<HarnessTarget, HarnessAdapter>;

export async function runHarnessCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];

  if (subcommand === "install") {
    const target = parseTarget(args[1]);
    const result = await installHarness({ target });
    return formatHarnessResults("Harness installed", [result], options);
  }

  if (subcommand === "uninstall") {
    const target = parseTarget(args[1]);
    const result = uninstallHarness({ target });
    return formatHarnessResults("Harness uninstalled", [result], options);
  }

  if (subcommand === "status") {
    const target = args[1] === undefined ? undefined : parseTarget(args[1]);
    const result = target === undefined ? inspectHarnesses() : [inspectHarness({ target })];
    return formatHarnessResults("Harness status", result, options);
  }

  throw new Error(`harness ${subcommand ?? ""} is not implemented yet`.trim());
}

export async function installHarness(input: {
  cwd?: string;
  registerClaudeSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  registerCodexSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  target: HarnessTarget;
}): Promise<HarnessStatus> {
  const adapter = getHarnessAdapter(input.target);
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const rawBinding = readBindingFile(projectRoot);
  if (rawBinding === undefined) {
    throw new Error(`run saga init before installing the ${input.target} harness`);
  }
  const binding = ensureLocalHostBinding(rawBinding);

  const hooksPath = adapter.hooksPath(projectRoot);
  const hookCommand = hookShimCommand(projectRoot, adapter);
  const hooksFile = readHooksSettingsFile(hooksPath, adapter);
  const sourceBinding = await registerHarnessSourceBinding(input)(
    projectRoot,
    binding.workspace.id,
    binding.host.id,
    binding.host.label,
  );
  const sourceUri = adapter.sourceUri(binding.host.id);

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
        sourceUri,
        target: input.target,
      },
    },
  };

  writeBindingFile(projectRoot, nextBinding);
  try {
    ensureGitignoreEntry(projectRoot, adapter.gitignoreEntries);
    installHookShim(projectRoot, adapter);
    writeJsonFile(hooksPath, installSagaHooks(hooksFile, hookCommand));
  } catch (error) {
    writeBindingFile(projectRoot, binding);
    throw error;
  }

  return inspectHarness({ cwd: projectRoot, target: input.target });
}

export function uninstallHarness(input: { cwd?: string; target: HarnessTarget }): HarnessStatus {
  const adapter = getHarnessAdapter(input.target);
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const binding = readBindingFile(projectRoot);
  const hooksPath = adapter.hooksPath(projectRoot);

  if (existsSync(hooksPath)) {
    const hooksFile = readHooksSettingsFile(hooksPath, adapter);
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
  return inspectTargetHarness(
    findProjectRoot(input.cwd ?? process.cwd()),
    getHarnessAdapter(input.target),
  );
}

export function inspectHarnesses(input: { cwd?: string } = {}): HarnessStatus[] {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  return listHarnessAdapters().map((adapter) => inspectTargetHarness(projectRoot, adapter));
}

function inspectTargetHarness(projectRoot: string, adapter: HarnessAdapter): HarnessStatus {
  const hooksPath = adapter.hooksPath(projectRoot);
  const binding = readBindingFile(projectRoot);
  const harnessBinding = binding?.harnesses?.[adapter.target];
  const expectedHookCommand = hookShimCommand(projectRoot, adapter);
  const hookCommand = harnessBinding?.hookCommand ?? expectedHookCommand;
  const hooksFile = tryReadHooksSettingsFile(hooksPath, adapter);
  if (!hooksFile.ok) {
    return {
      binding: harnessBinding === undefined ? "missing" : "installed",
      displayName: adapter.displayName,
      hookCommand,
      hooks: "invalid",
      hooksCoverage: "none",
      hooksError: formatHooksSettingsParseError(hooksFile.error),
      hookTrust: "not installed",
      hooksPath,
      mcp: "deferred",
      skills: "deferred",
      state: "invalid",
      stateDetail: formatHooksSettingsParseError(hooksFile.error),
      target: adapter.target,
    };
  }

  const sagaHookCoverage = inspectSagaHookCoverage(hooksFile.file, {
    hookCommand,
    target: adapter.target,
  });
  const hooksInstalled = sagaHookCoverage === "complete";
  const bindingIssue = validateHarnessBindingSnapshot(harnessBinding);
  if (bindingIssue !== undefined) {
    return {
      binding: "installed",
      displayName: adapter.displayName,
      hookCommand,
      hookTrust: hooksInstalled ? "requires review" : "not installed",
      hooksCoverage: sagaHookCoverage,
      hooks: hooksInstalled ? "installed" : "missing",
      hooksPath,
      mcp: "deferred",
      skills: "deferred",
      state: "invalid",
      stateDetail: `invalid harness binding: ${bindingIssue}`,
      target: adapter.target,
    };
  }
  const state = classifyHarnessState({
    adapter,
    expectedHookCommand,
    expectedHooksPath: hooksPath,
    expectedSourceUri:
      binding?.host?.id === undefined ? undefined : adapter.sourceUri(binding.host.id),
    harnessBinding,
    sagaHookCoverage,
    hooksInstalled,
  });
  return {
    binding: harnessBinding === undefined ? "missing" : "installed",
    displayName: adapter.displayName,
    hookCommand,
    hookTrust: hooksInstalled ? "requires review" : "not installed",
    hooksCoverage: sagaHookCoverage,
    hooks: hooksInstalled ? "installed" : "missing",
    hooksPath,
    mcp: "deferred",
    skills: "deferred",
    state: state.state,
    stateDetail: state.detail,
    target: adapter.target,
  };
}

function validateHarnessBindingSnapshot(
  binding: Partial<HarnessBindingSnapshot> | undefined,
): string | undefined {
  if (binding === undefined) return undefined;
  const requiredStrings = [
    "hookCommand",
    "hooksPath",
    "installedAt",
    "sourceBindingId",
    "sourceUri",
    "target",
  ] as const satisfies readonly (keyof HarnessBindingSnapshot)[];
  const invalidField = requiredStrings.find(
    (field) => typeof binding[field] !== "string" || binding[field].trim() === "",
  );
  if (invalidField !== undefined) return `${invalidField} must be a non-empty string`;
  if (binding.hookTrust !== "requires-review") return "hookTrust must be requires-review";
  return undefined;
}

function classifyHarnessState(input: {
  adapter: HarnessAdapter;
  expectedHookCommand: string;
  expectedHooksPath: string;
  expectedSourceUri: HarnessSourceUri | undefined;
  harnessBinding: HarnessBindingSnapshot | undefined;
  sagaHookCoverage: "complete" | "partial" | "none";
  hooksInstalled: boolean;
}): { detail: string; state: HarnessIntegrationState } {
  const bindingInstalled = input.harnessBinding !== undefined;
  if (!bindingInstalled && input.sagaHookCoverage === "none") {
    return { detail: "binding and hooks are not installed", state: "missing" };
  }

  if (!bindingInstalled) {
    return {
      detail: activeHooksWithoutBindingDetail(input.sagaHookCoverage),
      state: "divergent",
    };
  }

  const staleReasons = staleHarnessBindingReasons(input);
  if (staleReasons.length > 0) {
    return { detail: staleReasons.join("; "), state: "stale" };
  }

  if (!input.hooksInstalled) {
    return { detail: bindingHookDivergenceDetail(input.sagaHookCoverage), state: "divergent" };
  }

  return { detail: "binding is valid and complete Saga hooks are active", state: "configured" };
}

function activeHooksWithoutBindingDetail(coverage: "complete" | "partial" | "none"): string {
  if (coverage === "complete") return "hooks are installed but local binding is missing";
  return "Saga hooks are partially installed but local binding is missing";
}

function bindingHookDivergenceDetail(coverage: "complete" | "partial" | "none"): string {
  if (coverage === "partial")
    return "local binding exists but Saga hooks are only partially installed";
  return "local binding exists but hooks are missing";
}

function staleHarnessBindingReasons(input: {
  adapter: HarnessAdapter;
  expectedHookCommand: string;
  expectedHooksPath: string;
  expectedSourceUri: HarnessSourceUri | undefined;
  harnessBinding: HarnessBindingSnapshot | undefined;
}): string[] {
  const binding = input.harnessBinding;
  if (binding === undefined) return [];

  const reasons: string[] = [];
  if (binding.target !== input.adapter.target) {
    reasons.push(`binding target is ${binding.target}, expected ${input.adapter.target}`);
  }
  if (input.expectedSourceUri === undefined) {
    reasons.push("local binding host id is missing");
  }
  if (input.expectedSourceUri !== undefined && binding.sourceUri !== input.expectedSourceUri) {
    reasons.push(`binding source URI is ${binding.sourceUri}, expected ${input.expectedSourceUri}`);
  }
  if (binding.hooksPath !== input.expectedHooksPath) {
    reasons.push("binding hooks path does not match the current adapter");
  }
  if (binding.hookCommand !== input.expectedHookCommand) {
    reasons.push("binding hook command does not match the current shim");
  }
  return reasons;
}

function formatHarnessResults(
  title: string,
  statuses: readonly HarnessStatus[],
  options: RenderOptions,
): string {
  return formatCommandOutput(
    {
      id: statuses.map((status) => status.target).join("\n"),
      records: statuses.map((status) => formatHarnessRecord(title, status, options)).join("\n\n"),
      value: statuses.length === 1 ? statuses[0] : statuses,
    },
    options.format,
  );
}

function formatHarnessRecord(title: string, status: HarnessStatus, options: RenderOptions): string {
  return recordBlock(
    statusesTitle(title, status),
    [
      { label: "target", value: status.target },
      { label: "state", value: status.state },
      { label: "detail", value: status.stateDetail },
      { label: "binding", value: status.binding },
      { label: "hooks", value: status.hooks },
      { label: "hooks coverage", value: status.hooksCoverage },
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
  );
}

function statusesTitle(title: string, status: HarnessStatus): string {
  return `${title}: ${status.displayName}`;
}

function parseTarget(value: string | undefined): HarnessTarget {
  if (value === "codex" || value === "claude") return value;
  if (value === undefined) throw new Error("harness target is required");
  throw new Error(`unsupported harness target: ${value}`);
}

export function listHarnessAdapters(): readonly HarnessAdapter[] {
  return HARNESS_TARGET_ORDER.map((target) => HARNESS_ADAPTERS[target]);
}

function getHarnessAdapter(target: HarnessTarget): HarnessAdapter {
  return HARNESS_ADAPTERS[target];
}

function hookShimCommand(projectRoot: string, adapter: HarnessAdapter): string {
  return quoteShellArg(adapter.shimPath(projectRoot));
}

function installHookShim(projectRoot: string, adapter: HarnessAdapter): string {
  const shimPath = adapter.shimPath(projectRoot);
  const cliPath = fileURLToPath(new URL("../bin/saga.js", import.meta.url));
  mkdirSync(dirname(shimPath), { recursive: true });
  writeFileSync(
    shimPath,
    ["#!/bin/sh", `exec ${quoteShellArg(cliPath)} ingest ${adapter.ingestCommand} "$@"`, ""].join(
      "\n",
    ),
  );
  chmodSync(shimPath, 0o755);
  return quoteShellArg(shimPath);
}

function registerHarnessSourceBinding(input: {
  registerClaudeSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  registerCodexSource?: (projectRoot: string, workspaceId: string) => Promise<{ id: string }>;
  target: HarnessTarget;
}): (
  projectRoot: string,
  workspaceId: string,
  hostId: string,
  hostLabel: string,
) => Promise<{ id: string }> {
  if (input.target === "claude") return input.registerClaudeSource ?? registerClaudeSourceBinding;
  return input.registerCodexSource ?? registerCodexSourceBinding;
}

async function registerClaudeSourceBinding(
  projectRoot: string,
  workspaceId: string,
  hostId: string,
  hostLabel: string,
) {
  return registerAgentSourceBinding(projectRoot, workspaceId, hostId, hostLabel, "claude");
}

async function registerCodexSourceBinding(
  projectRoot: string,
  workspaceId: string,
  hostId: string,
  hostLabel: string,
) {
  return registerAgentSourceBinding(projectRoot, workspaceId, hostId, hostLabel, "codex");
}

async function registerAgentSourceBinding(
  projectRoot: string,
  workspaceId: string,
  hostId: string,
  hostLabel: string,
  target: HarnessTarget,
) {
  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  const adapter = getHarnessAdapter(target);
  try {
    await Effect.runPromise(assertMigrationsCurrent(service));
    const sourceUri = adapter.sourceUri(hostId);
    return await Effect.runPromise(
      registerSourceBinding(service, {
        config: {
          hostId,
          hostLabel,
          projectRoot,
        },
        displayName: `${adapter.displayName} on ${hostLabel}`,
        sourceType: adapter.sourceType,
        sourceUri,
        workspaceId,
      }),
    );
  } finally {
    await Effect.runPromise(service.close());
  }
}

function readHooksSettingsFile(path: string, adapter: HarnessAdapter): HooksSettingsFile {
  const result = tryReadHooksSettingsFile(path, adapter);
  if (result.ok) return result.file;
  throw new Error(formatHooksSettingsParseError(result.error));
}

function tryReadHooksSettingsFile(path: string, adapter: HarnessAdapter): HooksSettingsReadResult {
  if (!existsSync(path)) return { file: {}, ok: true };
  try {
    return { file: parseHooksSettingsFile(JSON.parse(readFileSync(path, "utf8"))), ok: true };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        path,
        target: adapter.target,
      },
      ok: false,
    };
  }
}

function formatHooksSettingsParseError(error: HooksSettingsParseError): string {
  const label = getHarnessAdapter(error.target).settingsLabel;
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

function inspectSagaHookCoverage(
  file: HooksSettingsFile,
  input: {
    hookCommand: string;
    target: HarnessTarget;
  },
): "complete" | "partial" | "none" {
  const legacyCommands = [LEGACY_HOOK_COMMANDS[input.target]];
  const hookScripts = [getHarnessAdapter(input.target).shimScriptName];
  const installedEvents = HARNESS_HOOK_EVENTS.filter((event) =>
    (file.hooks?.[event] ?? []).some((matcher) =>
      (matcher.hooks ?? []).some((hook) =>
        isSagaHookCommand(hook, input.hookCommand, legacyCommands, hookScripts),
      ),
    ),
  );

  if (installedEvents.length === HARNESS_HOOK_EVENTS.length) return "complete";
  return installedEvents.length > 0 ? "partial" : "none";
}

function withoutSagaHooks(
  matchers: readonly HookMatcher[],
  hookCommand?: string,
  target?: HarnessTarget,
): HookMatcher[] {
  const legacyCommands: readonly string[] =
    target === undefined ? Object.values(LEGACY_HOOK_COMMANDS) : [LEGACY_HOOK_COMMANDS[target]];
  const hookScripts: readonly string[] =
    target === undefined
      ? listHarnessAdapters().map((adapter) => adapter.shimScriptName)
      : [getHarnessAdapter(target).shimScriptName];
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
