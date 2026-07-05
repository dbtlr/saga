import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertMigrationsCurrent,
  listHarnessActivationRawEvents,
  makeDatabase,
  registerSourceBinding,
} from '@saga/db';
import type { RawEvent } from '@saga/db';
import { DATABASE_URL_ENV, loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { isCompiledBinary, stableBinPath } from './binary.js';
import {
  ensureLocalHostBinding,
  findProjectRoot,
  readBindingFile,
  writeBindingFile,
} from './init.js';
import type { WorkspaceBindingFile } from './init.js';
import { formatCommandOutput } from './output.js';
import { recordBlock } from './render.js';
import type { RenderOptions } from './render.js';

export type HarnessTarget = 'codex' | 'claude';
export type HookCoverage = 'complete' | 'partial' | 'none';
export type HarnessIntegrationState =
  | 'configured'
  | 'divergent'
  | 'invalid'
  | 'missing'
  | 'pending-trust'
  | 'stale';

export type HarnessActivationState =
  | 'active'
  | 'manual-only'
  | 'missing-binding'
  | 'missing-database'
  | 'missing-hooks'
  | 'no-evidence'
  | 'not-applicable'
  | 'stale'
  | 'unavailable';

export type HarnessActivationStatus = {
  checkedAt: string;
  detail: string;
  lastEvent?: {
    eventType: string;
    occurredAt: string;
  };
  nextStep?: string;
  recentWithinHours: number;
  sessionStartSources: {
    observed: readonly string[];
    unproven: readonly string[];
  };
  state: HarnessActivationState;
};

export type HarnessStatus = {
  activation: HarnessActivationStatus;
  binding: 'installed' | 'missing';
  displayName: string;
  hookCommand: string;
  hookTrust: 'not installed' | 'pending user trust' | 'requires review' | 'trusted by evidence';
  hooksCoverage: HookCoverage;
  hooks: 'installed' | 'invalid' | 'missing';
  hooksError?: string;
  hooksPath: string;
  state: HarnessIntegrationState;
  stateDetail: string;
  mcp: 'installed' | 'divergent' | 'missing' | 'manual';
  mcpDetail: string;
  mcpPath: string;
  nextStep: string | undefined;
  sessionStartCoverage: HookCoverage;
  sessionStartDetail: string;
  skills: 'deferred';
  target: HarnessTarget;
};

export type CodexHarnessStatus = HarnessStatus & { target: 'codex' };

type HarnessSourceUri = `codex://host/${string}` | `claude://host/${string}`;

export type HarnessAdapter = {
  displayName: string;
  gitignoreEntries: readonly string[];
  hooksPath: (projectRoot: string) => string;
  ingestCommand: 'codex-hook' | 'claude-hook';
  settingsLabel: string;
  shimScriptName: string;
  shimPath: (projectRoot: string) => string;
  sourceUri: (hostId: string) => HarnessSourceUri;
  sourceType: HarnessTarget;
  target: HarnessTarget;
};

type HarnessBindingSnapshot = {
  hookCommand: string;
  hookTrust: string;
  hooksPath: string;
  installedAt: string;
  sourceBindingId: string;
  sourceUri: string;
  target: string;
};

type HookCommand = {
  command: string;
  statusMessage?: string;
  timeout?: number;
  type: 'command';
};

type HookMatcher = {
  hooks?: HookCommand[];
  matcher?: string;
};

type HooksSettingsFile = {
  hooks?: Record<string, HookMatcher[]>;
};

type HooksSettingsParseError = {
  message: string;
  path: string;
  target: HarnessTarget;
};

type HooksSettingsReadResult =
  | { file: HooksSettingsFile; ok: true }
  | { error: HooksSettingsParseError; ok: false };

type McpConfigFile = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
};

type McpConfigParseError = {
  message: string;
  path: string;
};

type McpConfigReadResult =
  | { file: McpConfigFile; ok: true }
  | { error: McpConfigParseError; ok: false };

type HarnessMcpStatus = Pick<HarnessStatus, 'mcp' | 'mcpDetail' | 'mcpPath'>;

const HARNESS_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const;
const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact'] as const;
const ACTIVATION_RECENT_WINDOW_HOURS = 24;
const ACTIVATION_RECENT_WINDOW_MS = ACTIVATION_RECENT_WINDOW_HOURS * 60 * 60 * 1000;
const LEGACY_HOOK_COMMANDS = {
  claude: 'saga ingest claude-hook',
  codex: 'saga ingest codex-hook',
} as const;
const LEGACY_CODEX_HOOK_COMMAND = 'saga ingest codex-hook';
const HOOK_TIMEOUT_SECONDS = 30;
const CODEX_MCP_CONFIG_LABEL = '~/.codex/config.toml';
const HARNESS_TARGET_ORDER = ['codex', 'claude'] as const satisfies readonly HarnessTarget[];
const HARNESS_ADAPTERS = {
  claude: {
    displayName: 'Claude Code',
    gitignoreEntries: ['.claude/settings.local.json', '.claude/saga-claude-hook.sh', '.mcp.json'],
    hooksPath: (projectRoot: string) => join(projectRoot, '.claude', 'settings.local.json'),
    ingestCommand: 'claude-hook',
    settingsLabel: 'Claude settings file',
    shimScriptName: 'saga-claude-hook.sh',
    shimPath: (projectRoot: string) => join(projectRoot, '.claude', 'saga-claude-hook.sh'),
    sourceUri: (hostId: string) => `claude://host/${hostId}`,
    sourceType: 'claude',
    target: 'claude',
  },
  codex: {
    displayName: 'Codex',
    gitignoreEntries: ['.codex/'],
    hooksPath: (projectRoot: string) => join(projectRoot, '.codex', 'hooks.json'),
    ingestCommand: 'codex-hook',
    settingsLabel: 'Codex hooks file',
    shimScriptName: 'saga-codex-hook.sh',
    shimPath: (projectRoot: string) => join(projectRoot, '.codex', 'saga-codex-hook.sh'),
    sourceUri: (hostId: string) => `codex://host/${hostId}`,
    sourceType: 'codex',
    target: 'codex',
  },
} as const satisfies Record<HarnessTarget, HarnessAdapter>;

export async function runHarnessCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];

  if (subcommand === 'install') {
    const target = parseTarget(args[1]);
    const result = await installHarness({ target });
    return formatHarnessResults('Harness installed', [result], options);
  }

  if (subcommand === 'uninstall') {
    const target = parseTarget(args[1]);
    const result = uninstallHarness({ target });
    return formatHarnessResults('Harness uninstalled', [result], options);
  }

  if (subcommand === 'status') {
    const target = args[1] === undefined ? undefined : parseTarget(args[1]);
    const result =
      target === undefined
        ? await inspectHarnessesWithActivation()
        : [await inspectHarnessWithActivation({ target })];
    return formatHarnessResults('Harness status', result, options);
  }

  throw new Error(`harness ${subcommand ?? ''} is not implemented yet`.trim());
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
  const mcpConfig =
    input.target === 'claude' ? readMcpConfigFile(claudeMcpConfigPath(projectRoot)) : undefined;
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
        hookTrust: 'requires-review',
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
    if (mcpConfig !== undefined) {
      writeJsonFile(claudeMcpConfigPath(projectRoot), installSagaMcpServer(mcpConfig));
    }
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

  if (input.target === 'claude') {
    removeSagaMcpServer(projectRoot);
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

export type HarnessActivationVerifier = (input: {
  projectRoot: string;
  status: HarnessStatus;
}) => Promise<HarnessActivationStatus>;

export async function inspectHarnessWithActivation(input: {
  cwd?: string;
  target: HarnessTarget;
  verifyActivation?: HarnessActivationVerifier;
}): Promise<HarnessStatus> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const status = inspectTargetHarness(projectRoot, getHarnessAdapter(input.target));
  const verifier = input.verifyActivation ?? verifyHarnessActivation;
  return applyActivationStatus(status, await verifier({ projectRoot, status }));
}

export async function inspectHarnessesWithActivation(
  input: {
    cwd?: string;
    verifyActivation?: HarnessActivationVerifier;
  } = {},
): Promise<HarnessStatus[]> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const verifier = input.verifyActivation ?? verifyHarnessActivation;
  const statuses = listHarnessAdapters().map((adapter) =>
    inspectTargetHarness(projectRoot, adapter),
  );
  return Promise.all(
    statuses.map(async (status) =>
      applyActivationStatus(status, await verifier({ projectRoot, status })),
    ),
  );
}

function inspectTargetHarness(projectRoot: string, adapter: HarnessAdapter): HarnessStatus {
  const hooksPath = adapter.hooksPath(projectRoot);
  const binding = readBindingFile(projectRoot);
  const harnessBinding = binding?.harnesses?.[adapter.target];
  const expectedHookCommand = hookShimCommand(projectRoot, adapter);
  const hookCommand = harnessBinding?.hookCommand ?? expectedHookCommand;
  const mcpStatus = inspectMcpStatus(projectRoot, adapter);
  const hooksFile = tryReadHooksSettingsFile(hooksPath, adapter);
  if (!hooksFile.ok) {
    return {
      activation: activationNotChecked(adapter.target),
      binding: harnessBinding === undefined ? 'missing' : 'installed',
      displayName: adapter.displayName,
      hookCommand,
      hooks: 'invalid',
      hooksCoverage: 'none',
      hooksError: formatHooksSettingsParseError(hooksFile.error),
      hookTrust: 'not installed',
      hooksPath,
      ...mcpStatus,
      nextStep: undefined,
      sessionStartCoverage: 'none',
      sessionStartDetail: 'SessionStart hook configuration could not be read',
      skills: 'deferred',
      state: 'invalid',
      stateDetail: formatHooksSettingsParseError(hooksFile.error),
      target: adapter.target,
    };
  }

  const sagaHookCoverage = inspectSagaHookCoverage(hooksFile.file, {
    hookCommand,
    target: adapter.target,
  });
  const hooksInstalled = sagaHookCoverage.hooksCoverage === 'complete';
  const bindingIssue = validateHarnessBindingSnapshot(harnessBinding);
  if (bindingIssue !== undefined) {
    return {
      activation: activationNotChecked(adapter.target),
      binding: 'installed',
      displayName: adapter.displayName,
      hookCommand,
      hookTrust: hooksInstalled ? 'requires review' : 'not installed',
      hooksCoverage: sagaHookCoverage.hooksCoverage,
      hooks: hooksInstalled ? 'installed' : 'missing',
      hooksPath,
      ...mcpStatus,
      nextStep: undefined,
      sessionStartCoverage: sagaHookCoverage.sessionStartCoverage,
      sessionStartDetail: sagaHookCoverage.sessionStartDetail,
      skills: 'deferred',
      state: 'invalid',
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
    sagaHookCoverage: sagaHookCoverage.hooksCoverage,
    hooksInstalled,
    sessionStartCoverage: sagaHookCoverage.sessionStartCoverage,
    sessionStartDetail: sagaHookCoverage.sessionStartDetail,
  });
  return {
    activation: activationNotChecked(adapter.target),
    binding: harnessBinding === undefined ? 'missing' : 'installed',
    displayName: adapter.displayName,
    hookCommand,
    hookTrust: hookTrustDisplay(adapter.target, hooksInstalled, state.state),
    hooksCoverage: sagaHookCoverage.hooksCoverage,
    hooks: hooksInstalled ? 'installed' : 'missing',
    hooksPath,
    ...mcpStatus,
    nextStep: nextStepForHarnessState(adapter.target, state.state),
    sessionStartCoverage: sagaHookCoverage.sessionStartCoverage,
    sessionStartDetail: sagaHookCoverage.sessionStartDetail,
    skills: 'deferred',
    state: state.state,
    stateDetail: state.detail,
    target: adapter.target,
  };
}

function validateHarnessBindingSnapshot(
  binding: Partial<HarnessBindingSnapshot> | undefined,
): string | undefined {
  if (binding === undefined) {
    return undefined;
  }
  const requiredStrings = [
    'hookCommand',
    'hooksPath',
    'installedAt',
    'sourceBindingId',
    'sourceUri',
    'target',
  ] as const satisfies readonly (keyof HarnessBindingSnapshot)[];
  const invalidField = requiredStrings.find(
    (field) => typeof binding[field] !== 'string' || binding[field].trim() === '',
  );
  if (invalidField !== undefined) {
    return `${invalidField} must be a non-empty string`;
  }
  if (binding.hookTrust !== 'requires-review') {
    return 'hookTrust must be requires-review';
  }
  return undefined;
}

function classifyHarnessState(input: {
  adapter: HarnessAdapter;
  expectedHookCommand: string;
  expectedHooksPath: string;
  expectedSourceUri: HarnessSourceUri | undefined;
  harnessBinding: HarnessBindingSnapshot | undefined;
  sagaHookCoverage: HookCoverage;
  hooksInstalled: boolean;
  sessionStartCoverage: HookCoverage;
  sessionStartDetail: string;
}): { detail: string; state: HarnessIntegrationState } {
  const bindingInstalled = input.harnessBinding !== undefined;
  if (!bindingInstalled && input.sagaHookCoverage === 'none') {
    return { detail: 'binding and hooks are not installed', state: 'missing' };
  }

  if (!bindingInstalled) {
    return {
      detail: activeHooksWithoutBindingDetail(input.sagaHookCoverage),
      state: 'divergent',
    };
  }

  const staleReasons = staleHarnessBindingReasons(input);
  if (staleReasons.length > 0) {
    return { detail: staleReasons.join('; '), state: 'stale' };
  }

  if (!input.hooksInstalled) {
    return { detail: bindingHookDivergenceDetail(input.sagaHookCoverage), state: 'divergent' };
  }

  if (input.sessionStartCoverage !== 'complete') {
    return {
      detail: `local binding exists but ${input.sessionStartDetail}`,
      state: 'divergent',
    };
  }

  if (input.adapter.target === 'codex' && input.harnessBinding?.hookTrust === 'requires-review') {
    return {
      detail:
        'binding and hooks are installed; Codex project-local hook trust is pending explicit user approval',
      state: 'pending-trust',
    };
  }

  return { detail: 'binding is valid and complete Saga hooks are active', state: 'configured' };
}

function activeHooksWithoutBindingDetail(coverage: HookCoverage): string {
  if (coverage === 'complete') {
    return 'hooks are installed but local binding is missing';
  }
  return 'Saga hooks are partially installed but local binding is missing';
}

function bindingHookDivergenceDetail(coverage: HookCoverage): string {
  if (coverage === 'partial') {
    return 'local binding exists but Saga hooks are only partially installed';
  }
  return 'local binding exists but hooks are missing';
}

function hookTrustDisplay(
  target: HarnessTarget,
  hooksInstalled: boolean,
  state: HarnessIntegrationState,
): HarnessStatus['hookTrust'] {
  if (!hooksInstalled) {
    return 'not installed';
  }
  if (target === 'codex' && state === 'pending-trust') {
    return 'pending user trust';
  }
  return 'requires review';
}

function nextStepForHarnessState(
  target: HarnessTarget,
  state: HarnessIntegrationState,
): string | undefined {
  if (target === 'codex' && state === 'pending-trust') {
    return 'approve Codex project-local hooks for this workspace, then restart Codex or start a new Codex session here';
  }
  return undefined;
}

function activationNotChecked(target: HarnessTarget): HarnessActivationStatus {
  return {
    checkedAt: new Date(0).toISOString(),
    detail:
      target === 'codex'
        ? 'activation evidence was not checked'
        : 'runtime activation verification is not implemented for this harness',
    recentWithinHours: ACTIVATION_RECENT_WINDOW_HOURS,
    sessionStartSources: {
      observed: [],
      unproven: [...SESSION_START_SOURCES],
    },
    state: target === 'codex' ? 'unavailable' : 'not-applicable',
  };
}

async function verifyHarnessActivation(input: {
  projectRoot: string;
  status: HarnessStatus;
}): Promise<HarnessActivationStatus> {
  const checkedAt = new Date();
  const adapter = getHarnessAdapter(input.status.target);

  try {
    const binding = readBindingFile(input.projectRoot);
    if (binding === undefined) {
      return missingBindingActivation(
        checkedAt,
        input.status.target,
        'workspace binding is missing; run saga init',
      );
    }

    const harnessBinding = binding.harnesses?.[input.status.target];
    if (harnessBinding?.sourceBindingId === undefined || harnessBinding.sourceBindingId === '') {
      return missingBindingActivation(
        checkedAt,
        input.status.target,
        `${adapter.displayName} harness source binding is missing; run saga harness install ${input.status.target}`,
      );
    }

    if (input.status.hooks !== 'installed') {
      return missingHooksActivation(
        checkedAt,
        input.status.target,
        `${adapter.displayName} harness hooks are ${input.status.hooks}; run saga harness install ${input.status.target}`,
      );
    }

    const config = await Effect.runPromise(loadRuntimeConfig({ cwd: input.projectRoot }));
    if (config.databaseUrl === undefined) {
      return {
        checkedAt: checkedAt.toISOString(),
        detail: `${DATABASE_URL_ENV} is not set; activation verification cannot query raw_events`,
        nextStep: `set ${DATABASE_URL_ENV} in this workspace, ensure migrations are current, then run saga harness status ${input.status.target} again`,
        recentWithinHours: ACTIVATION_RECENT_WINDOW_HOURS,
        sessionStartSources: {
          observed: [],
          unproven: [...SESSION_START_SOURCES],
        },
        state: 'missing-database',
      };
    }

    const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
    try {
      await Effect.runPromise(assertMigrationsCurrent(service));
      const events = await Effect.runPromise(
        listHarnessActivationRawEvents(service, {
          sourceBindingId: harnessBinding.sourceBindingId,
          sourceType: input.status.target,
          workspaceId: binding.workspace.id,
        }),
      );
      return classifyHarnessActivationEvidence({
        checkedAt,
        events,
        target: input.status.target,
      });
    } finally {
      await Effect.runPromise(service.close());
    }
  } catch (error) {
    return {
      checkedAt: checkedAt.toISOString(),
      detail: `could not query ${adapter.displayName} activation evidence: ${
        error instanceof Error ? error.message : String(error)
      }`,
      nextStep: `fix database connectivity and migrations, then run saga harness status ${input.status.target} again`,
      recentWithinHours: ACTIVATION_RECENT_WINDOW_HOURS,
      sessionStartSources: {
        observed: [],
        unproven: [...SESSION_START_SOURCES],
      },
      state: 'unavailable',
    };
  }
}

function missingBindingActivation(
  checkedAt: Date,
  target: HarnessTarget,
  detail: string,
): HarnessActivationStatus {
  return {
    checkedAt: checkedAt.toISOString(),
    detail,
    nextStep: `run saga init and saga harness install ${target} before checking activation`,
    recentWithinHours: ACTIVATION_RECENT_WINDOW_HOURS,
    sessionStartSources: {
      observed: [],
      unproven: [...SESSION_START_SOURCES],
    },
    state: 'missing-binding',
  };
}

function missingHooksActivation(
  checkedAt: Date,
  target: HarnessTarget,
  detail: string,
): HarnessActivationStatus {
  return {
    checkedAt: checkedAt.toISOString(),
    detail,
    nextStep: `run saga harness install ${target}, start a new ${getHarnessAdapter(target).displayName} session in this workspace, submit a prompt, then run saga harness status ${target} again`,
    recentWithinHours: ACTIVATION_RECENT_WINDOW_HOURS,
    sessionStartSources: {
      observed: [],
      unproven: [...SESSION_START_SOURCES],
    },
    state: 'missing-hooks',
  };
}

function classifyHarnessActivationEvidence(input: {
  checkedAt?: Date;
  events: readonly RawEvent[];
  recentWindowMs?: number;
  target: HarnessTarget;
}): HarnessActivationStatus {
  const checkedAt = input.checkedAt ?? new Date();
  const recentWindowMs = input.recentWindowMs ?? ACTIVATION_RECENT_WINDOW_MS;
  const recentWithinHours = Math.round(recentWindowMs / (60 * 60 * 1000));
  const adapter = getHarnessAdapter(input.target);
  const ordered = [...input.events].toSorted(
    (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime(),
  );
  const realHookEvents = ordered.filter((event) => isRealActivationEvent(event, input.target));
  const latestRealHookEvent = realHookEvents[0];
  const recentCutoff = checkedAt.getTime() - recentWindowMs;
  const recentRealHookEvent = realHookEvents.find(
    (event) => event.occurredAt.getTime() >= recentCutoff,
  );
  const observedSources = sessionStartSourcesFor(realHookEvents, input.target);
  const unprovenSources = SESSION_START_SOURCES.filter(
    (source) => !observedSources.includes(source),
  );

  if (recentRealHookEvent !== undefined) {
    return {
      checkedAt: checkedAt.toISOString(),
      detail: `recent ${adapter.displayName} hook raw_event found: ${eventSummary(
        recentRealHookEvent,
      )}; ${sessionStartSourceDetail(observedSources, unprovenSources)}`,
      lastEvent: rawEventPointer(recentRealHookEvent),
      recentWithinHours,
      sessionStartSources: {
        observed: observedSources,
        unproven: unprovenSources,
      },
      state: 'active',
    };
  }

  if (latestRealHookEvent !== undefined) {
    return {
      checkedAt: checkedAt.toISOString(),
      detail: `latest real ${adapter.displayName} hook raw_event is stale: ${eventSummary(
        latestRealHookEvent,
      )}; no real ${adapter.displayName} SessionStart/UserPromptSubmit raw_event was observed in the last ${String(
        recentWithinHours,
      )}h`,
      lastEvent: rawEventPointer(latestRealHookEvent),
      nextStep: staleActivationNextStep(input.target),
      recentWithinHours,
      sessionStartSources: {
        observed: observedSources,
        unproven: unprovenSources,
      },
      state: 'stale',
    };
  }

  if (ordered.length > 0) {
    return {
      checkedAt: checkedAt.toISOString(),
      detail: `matching ${adapter.displayName} raw_events exist, but they are manual/synthetic or lack hook provenance; real ${adapter.displayName} hook activation is not proven`,
      lastEvent: rawEventPointer(ordered[0]!),
      nextStep: manualActivationNextStep(input.target),
      recentWithinHours,
      sessionStartSources: {
        observed: [],
        unproven: [...SESSION_START_SOURCES],
      },
      state: 'manual-only',
    };
  }

  return {
    checkedAt: checkedAt.toISOString(),
    detail: `no ${adapter.displayName} SessionStart/UserPromptSubmit raw_events found for this workspace source binding in the last ${String(
      recentWithinHours,
    )}h`,
    nextStep: noEvidenceActivationNextStep(input.target),
    recentWithinHours,
    sessionStartSources: {
      observed: [],
      unproven: [...SESSION_START_SOURCES],
    },
    state: 'no-evidence',
  };
}

export function classifyCodexActivationEvidence(input: {
  checkedAt?: Date;
  events: readonly RawEvent[];
  recentWindowMs?: number;
}): HarnessActivationStatus {
  return classifyHarnessActivationEvidence({ ...input, target: 'codex' });
}

export function classifyClaudeActivationEvidence(input: {
  checkedAt?: Date;
  events: readonly RawEvent[];
  recentWindowMs?: number;
}): HarnessActivationStatus {
  return classifyHarnessActivationEvidence({ ...input, target: 'claude' });
}

function staleActivationNextStep(target: HarnessTarget): string {
  if (target === 'codex') {
    return 'restart Codex or start a new Codex session in this workspace, submit a prompt, then run saga harness status codex again';
  }
  return 'start or resume Claude Code in this workspace, submit a prompt, then run saga harness status claude again';
}

function manualActivationNextStep(target: HarnessTarget): string {
  if (target === 'codex') {
    return 'use an interactive Codex session in this workspace, approve hooks if prompted, submit a prompt, then run saga harness status codex again';
  }
  return 'use an interactive Claude Code session in this workspace, submit a prompt, then run saga harness status claude again';
}

function noEvidenceActivationNextStep(target: HarnessTarget): string {
  if (target === 'codex') {
    return 'approve Codex project-local hooks if prompted, restart Codex or start a new Codex session in this workspace, submit a prompt, then run saga harness status codex again';
  }
  return 'start or resume Claude Code in this workspace, submit a prompt, then run saga harness status claude again';
}

function applyActivationStatus(
  status: HarnessStatus,
  activation: HarnessActivationStatus,
): HarnessStatus {
  if (status.target !== 'codex') {
    return {
      ...status,
      activation,
      nextStep: status.nextStep ?? activation.nextStep,
    };
  }
  if (status.state === 'pending-trust' && activation.state === 'active') {
    return {
      ...status,
      activation,
      hookTrust: 'trusted by evidence',
      nextStep: undefined,
      state: 'configured',
      stateDetail: `binding and hooks are installed; ${activation.detail}`,
    };
  }
  if (status.state === 'pending-trust' && activation.state !== 'not-applicable') {
    return {
      ...status,
      activation,
      nextStep: activation.nextStep ?? status.nextStep,
      stateDetail: `binding and hooks are installed, but ${activation.detail}`,
    };
  }
  return {
    ...status,
    activation,
    nextStep: status.nextStep ?? activation.nextStep,
  };
}

function isRealActivationEvent(event: RawEvent, target: HarnessTarget): boolean {
  if (event.sourceType !== target) {
    return false;
  }
  if (
    event.eventType !== `${target}.SessionStart` &&
    event.eventType !== `${target}.UserPromptSubmit`
  ) {
    return false;
  }
  if (hasManualSyntheticMarker(event.payload) || hasManualSyntheticMarker(event.provenance)) {
    return false;
  }

  const hookEventName =
    stringValue(event.provenance.hookEventName) ?? stringValue(event.payload.hook_event_name);
  return event.eventType === `${target}.${hookEventName}`;
}

function hasManualSyntheticMarker(value: Record<string, unknown>): boolean {
  const markerKeys = ['manual', 'synthetic', 'isManual', 'isSynthetic', 'sagaManualIngest'];
  if (markerKeys.some((key) => value[key] === true)) {
    return true;
  }
  const markerValues = new Set(['manual', 'synthetic']);
  return ['origin', 'source', 'mode', 'captureMode'].some((key) => {
    const marker = stringValue(value[key]);
    return marker !== undefined && markerValues.has(marker.toLowerCase());
  });
}

function sessionStartSourcesFor(
  events: readonly RawEvent[],
  target: HarnessTarget,
): readonly string[] {
  const observed = new Set<string>();
  for (const event of events) {
    if (event.eventType !== `${target}.SessionStart`) {
      continue;
    }
    const source =
      stringValue(event.payload.source) ??
      stringValue(event.payload.session_start_source) ??
      stringValue(event.provenance.source) ??
      stringValue(event.provenance.sessionStartSource);
    if (source !== undefined && (SESSION_START_SOURCES as readonly string[]).includes(source)) {
      observed.add(source);
    }
  }
  return SESSION_START_SOURCES.filter((source) => observed.has(source));
}

function sessionStartSourceDetail(
  observedSources: readonly string[],
  unprovenSources: readonly string[],
): string {
  if (observedSources.length === 0) {
    return 'SessionStart lifecycle source evidence is not yet observed';
  }
  if (unprovenSources.length === 0) {
    return `SessionStart sources observed: ${observedSources.join(', ')}`;
  }
  return `SessionStart sources observed: ${observedSources.join(', ')}; unproven: ${unprovenSources.join(', ')}`;
}

function eventSummary(event: RawEvent): string {
  return `${event.eventType} at ${event.occurredAt.toISOString()}`;
}

function rawEventPointer(event: RawEvent): NonNullable<HarnessActivationStatus['lastEvent']> {
  return {
    eventType: event.eventType,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function staleHarnessBindingReasons(input: {
  adapter: HarnessAdapter;
  expectedHookCommand: string;
  expectedHooksPath: string;
  expectedSourceUri: HarnessSourceUri | undefined;
  harnessBinding: HarnessBindingSnapshot | undefined;
}): string[] {
  const binding = input.harnessBinding;
  if (binding === undefined) {
    return [];
  }

  const reasons: string[] = [];
  if (binding.target !== input.adapter.target) {
    reasons.push(`binding target is ${binding.target}, expected ${input.adapter.target}`);
  }
  if (input.expectedSourceUri === undefined) {
    reasons.push('local binding host id is missing');
  }
  if (input.expectedSourceUri !== undefined && binding.sourceUri !== input.expectedSourceUri) {
    reasons.push(`binding source URI is ${binding.sourceUri}, expected ${input.expectedSourceUri}`);
  }
  if (binding.hooksPath !== input.expectedHooksPath) {
    reasons.push('binding hooks path does not match the current adapter');
  }
  if (binding.hookCommand !== input.expectedHookCommand) {
    reasons.push('binding hook command does not match the current shim');
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
      id: statuses.map((status) => status.target).join('\n'),
      records: statuses.map((status) => formatHarnessRecord(title, status, options)).join('\n\n'),
      value: statuses.length === 1 ? statuses[0] : statuses,
    },
    options.format,
  );
}

function formatHarnessRecord(title: string, status: HarnessStatus, options: RenderOptions): string {
  return recordBlock(
    statusesTitle(title, status),
    [
      { label: 'target', value: status.target },
      { label: 'state', value: status.state },
      { label: 'detail', value: status.stateDetail },
      { label: 'binding', value: status.binding },
      { label: 'hooks', value: status.hooks },
      { label: 'hooks coverage', value: status.hooksCoverage },
      ...(status.hooksError === undefined
        ? []
        : [{ label: 'hooks error', value: status.hooksError }]),
      {
        label: 'session start',
        value: `${status.sessionStartCoverage}; ${status.sessionStartDetail}`,
      },
      {
        label: 'activation',
        value: `${status.activation.state}; ${status.activation.detail}`,
      },
      { label: 'hook trust', value: status.hookTrust },
      ...(status.nextStep === undefined ? [] : [{ label: 'next step', value: status.nextStep }]),
      { label: 'hooks path', value: status.hooksPath },
      { label: 'hook command', value: status.hookCommand },
      { label: 'mcp', value: `${status.mcp}; ${status.mcpDetail}` },
      { label: 'mcp path', value: status.mcpPath },
      { label: 'skills', value: 'deferred until Saga skills are packaged' },
    ],
    options,
  );
}

function statusesTitle(title: string, status: HarnessStatus): string {
  return `${title}: ${status.displayName}`;
}

function parseTarget(value: string | undefined): HarnessTarget {
  if (value === 'codex' || value === 'claude') {
    return value;
  }
  if (value === undefined) {
    throw new Error('harness target is required');
  }
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
  const cliPath = sagaCliPath();
  mkdirSync(dirname(shimPath), { recursive: true });
  writeFileSync(
    shimPath,
    ['#!/bin/sh', `exec ${quoteShellArg(cliPath)} ingest ${adapter.ingestCommand} "$@"`, ''].join(
      '\n',
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
  if (input.target === 'claude') {
    return input.registerClaudeSource ?? registerClaudeSourceBinding;
  }
  return input.registerCodexSource ?? registerCodexSourceBinding;
}

async function registerClaudeSourceBinding(
  projectRoot: string,
  workspaceId: string,
  hostId: string,
  hostLabel: string,
) {
  return registerAgentSourceBinding(projectRoot, workspaceId, hostId, hostLabel, 'claude');
}

async function registerCodexSourceBinding(
  projectRoot: string,
  workspaceId: string,
  hostId: string,
  hostLabel: string,
) {
  return registerAgentSourceBinding(projectRoot, workspaceId, hostId, hostLabel, 'codex');
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

function claudeMcpConfigPath(projectRoot: string): string {
  return join(projectRoot, '.mcp.json');
}

/**
 * Harness integration references (the Claude `.mcp.json` saga command and each
 * installed hook shim's exec target) that still resolve to a checkout path instead
 * of the stable install path — the harness inputs to doctor's convergence guide
 * (ADR-0044). Only meaningful for a compiled binary; the caller gates on that. An
 * absent integration contributes nothing. `home` overrides the stable-path base for
 * tests.
 */
export function staleHarnessReferences(
  projectRoot: string,
  home?: string,
): { fix: string; label: string }[] {
  const stablePath = home === undefined ? stableBinPath() : stableBinPath(home);
  const stale: { fix: string; label: string }[] = [];

  const mcpResult = tryReadMcpConfigFile(claudeMcpConfigPath(projectRoot));
  if (mcpResult.ok) {
    const servers = isRecord(mcpResult.file.mcpServers) ? mcpResult.file.mcpServers : {};
    const saga = servers.saga;
    const command = isRecord(saga) && typeof saga.command === 'string' ? saga.command : undefined;
    if (command !== undefined && command !== stablePath) {
      stale.push({ fix: 'saga harness install claude', label: '.mcp.json saga command' });
    }
  }

  for (const target of HARNESS_TARGET_ORDER) {
    const shimPath = HARNESS_ADAPTERS[target].shimPath(projectRoot);
    if (!existsSync(shimPath)) {
      continue;
    }
    if (!readFileSync(shimPath, 'utf8').includes(stablePath)) {
      stale.push({ fix: `saga harness install ${target}`, label: `${target} hook shim` });
    }
  }

  return stale;
}

function sagaCliPath(): string {
  // The one saga executable every integration reference points at — the Claude
  // hook shim and .mcp.json's mcpServers.saga.command. Compiled: the single stable
  // install path (ADR-0044), so a self-update swap converges every integration at
  // once. Source: the repo's bin/saga.js shim so a checkout keeps working. Reuses
  // binary.ts; no re-derived detection.
  return isCompiledBinary()
    ? stableBinPath()
    : fileURLToPath(new URL('../bin/saga.js', import.meta.url));
}

function sagaMcpServerEntry(): { args: string[]; command: string } {
  return { args: ['mcp'], command: sagaCliPath() };
}

function readMcpConfigFile(path: string): McpConfigFile {
  const result = tryReadMcpConfigFile(path);
  if (result.ok) {
    return result.file;
  }
  throw new Error(formatMcpConfigParseError(result.error));
}

function tryReadMcpConfigFile(path: string): McpConfigReadResult {
  if (!existsSync(path)) {
    return { file: {}, ok: true };
  }
  try {
    return { file: parseMcpConfigFile(JSON.parse(readFileSync(path, 'utf8'))), ok: true };
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

function formatMcpConfigParseError(error: McpConfigParseError): string {
  return `invalid Claude MCP config file ${error.path}: ${error.message}`;
}

function parseMcpConfigFile(value: unknown): McpConfigFile {
  if (!isRecord(value)) {
    throw new Error('expected a JSON object');
  }
  if (value.mcpServers !== undefined && !isRecord(value.mcpServers)) {
    throw new Error('expected mcpServers to be an object');
  }
  return value as McpConfigFile;
}

function installSagaMcpServer(file: McpConfigFile): McpConfigFile {
  const servers = isRecord(file.mcpServers) ? file.mcpServers : {};
  return { ...file, mcpServers: { ...servers, saga: sagaMcpServerEntry() } };
}

function removeSagaMcpServer(projectRoot: string): void {
  const path = claudeMcpConfigPath(projectRoot);
  if (!existsSync(path)) {
    return;
  }
  const file = readMcpConfigFile(path);
  const servers = isRecord(file.mcpServers) ? file.mcpServers : {};
  const { saga: _saga, ...remainingServers } = servers;
  const hasOtherTopLevelKeys = Object.keys(file).some((key) => key !== 'mcpServers');
  if (!hasOtherTopLevelKeys && Object.keys(remainingServers).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeJsonFile(path, { ...file, mcpServers: remainingServers });
}

function inspectMcpStatus(projectRoot: string, adapter: HarnessAdapter): HarnessMcpStatus {
  if (adapter.target === 'codex') {
    return {
      mcp: 'manual',
      mcpDetail: codexMcpManualDetail(),
      mcpPath: CODEX_MCP_CONFIG_LABEL,
    };
  }

  const mcpPath = claudeMcpConfigPath(projectRoot);
  const result = tryReadMcpConfigFile(mcpPath);
  if (!result.ok) {
    return {
      mcp: 'divergent',
      mcpDetail: `${formatMcpConfigParseError(result.error)}; fix or remove the file, then run saga harness install claude`,
      mcpPath,
    };
  }

  const servers = isRecord(result.file.mcpServers) ? result.file.mcpServers : {};
  const sagaEntry = servers.saga;
  if (sagaEntry === undefined) {
    return {
      mcp: 'missing',
      mcpDetail: 'Saga MCP server is not registered; run saga harness install claude',
      mcpPath,
    };
  }

  const differences = sagaMcpEntryDifferences(sagaEntry);
  if (differences.length > 0) {
    return {
      mcp: 'divergent',
      mcpDetail: `mcpServers.saga diverges: ${differences.join('; ')}; run saga harness install claude to rewrite it`,
      mcpPath,
    };
  }

  return {
    mcp: 'installed',
    mcpDetail: 'mcpServers.saga launches the Saga CLI MCP server',
    mcpPath,
  };
}

function sagaMcpEntryDifferences(entry: unknown): string[] {
  if (!isRecord(entry)) {
    return ['entry is not an object'];
  }
  const expected = sagaMcpServerEntry();
  const differences: string[] = [];
  if (entry.command !== expected.command) {
    differences.push('command does not match the expected Saga CLI path');
  }
  const args = entry.args;
  const argsMatch =
    Array.isArray(args) &&
    args.length === expected.args.length &&
    expected.args.every((arg, index) => args[index] === arg);
  if (!argsMatch) {
    differences.push('args do not equal ["mcp"]');
  }
  return differences;
}

function codexMcpManualDetail(): string {
  return [
    `Codex MCP servers are user-global; add to ${CODEX_MCP_CONFIG_LABEL}:`,
    '[mcp_servers.saga]',
    `command = "${sagaCliPath()}"`,
    'args = ["mcp"]',
  ].join('\n');
}

function readHooksSettingsFile(path: string, adapter: HarnessAdapter): HooksSettingsFile {
  const result = tryReadHooksSettingsFile(path, adapter);
  if (result.ok) {
    return result.file;
  }
  throw new Error(formatHooksSettingsParseError(result.error));
}

function tryReadHooksSettingsFile(path: string, adapter: HarnessAdapter): HooksSettingsReadResult {
  if (!existsSync(path)) {
    return { file: {}, ok: true };
  }
  try {
    return { file: parseHooksSettingsFile(JSON.parse(readFileSync(path, 'utf8'))), ok: true };
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
    throw new Error('expected a JSON object');
  }

  if (value.hooks === undefined) {
    return value as HooksSettingsFile;
  }
  if (!isRecord(value.hooks)) {
    throw new Error('expected hooks to be an object');
  }

  for (const [event, matchers] of Object.entries(value.hooks)) {
    if (!Array.isArray(matchers)) {
      throw new Error(`expected hooks.${event} to be an array`);
    }

    for (const [matcherIndex, matcher] of matchers.entries()) {
      if (!isRecord(matcher)) {
        throw new Error(`expected hooks.${event}[${matcherIndex}] to be an object`);
      }

      if (matcher.hooks === undefined) {
        continue;
      }
      if (!Array.isArray(matcher.hooks)) {
        throw new Error(`expected hooks.${event}[${matcherIndex}].hooks to be an array`);
      }

      for (const [hookIndex, hook] of matcher.hooks.entries()) {
        if (!isRecord(hook)) {
          throw new Error(
            `expected hooks.${event}[${matcherIndex}].hooks[${hookIndex}] to be an object`,
          );
        }
        if (hook.command !== undefined && typeof hook.command !== 'string') {
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const gitignorePath = join(projectRoot, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const lines = new Set(existing.split(/\r?\n/).filter((line) => line.length > 0));
  const missingEntries = entries.filter((entry) => !lines.has(entry));
  if (missingEntries.length === 0) {
    return;
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${existing}${prefix}${missingEntries.join('\n')}\n`);
}

function installSagaHooks(file: HooksSettingsFile, hookCommand: string): HooksSettingsFile {
  const hooks = { ...file.hooks };
  for (const event of HARNESS_HOOK_EVENTS) {
    const matchers = withoutSagaHooks(hooks[event] ?? []);
    matchers.push({
      ...(event === 'SessionStart' ? { matcher: 'startup|resume|clear|compact' } : {}),
      hooks: [
        {
          command: hookCommand,
          statusMessage: 'Syncing Saga workspace memory',
          timeout: HOOK_TIMEOUT_SECONDS,
          type: 'command',
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

function hooksCoverageLevel(installedEventCount: number): HookCoverage {
  if (installedEventCount === HARNESS_HOOK_EVENTS.length) {
    return 'complete';
  }
  return installedEventCount > 0 ? 'partial' : 'none';
}

function inspectSagaHookCoverage(
  file: HooksSettingsFile,
  input: {
    hookCommand: string;
    target: HarnessTarget;
  },
): {
  hooksCoverage: HookCoverage;
  sessionStartCoverage: HookCoverage;
  sessionStartDetail: string;
} {
  const legacyCommands = [LEGACY_HOOK_COMMANDS[input.target]];
  const hookScripts = [getHarnessAdapter(input.target).shimScriptName];
  const installedEvents = HARNESS_HOOK_EVENTS.filter((event) =>
    (file.hooks?.[event] ?? []).some((matcher) =>
      (matcher.hooks ?? []).some((hook) =>
        isSagaHookCommand(hook, input.hookCommand, legacyCommands, hookScripts),
      ),
    ),
  );
  const sessionStartCoverage = inspectSessionStartSourceCoverage(file, {
    hookCommand: input.hookCommand,
    hookScripts,
    legacyCommands,
  });

  const hooksCoverage = hooksCoverageLevel(installedEvents.length);

  return {
    hooksCoverage,
    sessionStartCoverage: sessionStartCoverage.coverage,
    sessionStartDetail: sessionStartCoverage.detail,
  };
}

function inspectSessionStartSourceCoverage(
  file: HooksSettingsFile,
  input: {
    hookCommand: string;
    legacyCommands: readonly string[];
    hookScripts: readonly string[];
  },
): { coverage: HookCoverage; detail: string } {
  const coveredSources = new Set<string>();
  const matchers = file.hooks?.SessionStart ?? [];

  for (const matcher of matchers) {
    const hasSagaHook = (matcher.hooks ?? []).some((hook) =>
      isSagaHookCommand(hook, input.hookCommand, input.legacyCommands, input.hookScripts),
    );
    if (!hasSagaHook) {
      continue;
    }

    for (const source of sourcesCoveredBySessionStartMatcher(matcher.matcher)) {
      coveredSources.add(source);
    }
  }

  if (coveredSources.size === 0) {
    return {
      coverage: 'none',
      detail: 'no recognized Saga SessionStart hook source coverage is configured',
    };
  }

  const missingSources = SESSION_START_SOURCES.filter((source) => !coveredSources.has(source));
  const configuredSources = SESSION_START_SOURCES.filter((source) => coveredSources.has(source));
  if (missingSources.length === 0) {
    return {
      coverage: 'complete',
      detail: `SessionStart sources configured: ${configuredSources.join(', ')}`,
    };
  }

  return {
    coverage: 'partial',
    detail: `SessionStart sources configured: ${configuredSources.join(', ')}; missing: ${missingSources.join(', ')}`,
  };
}

function sourcesCoveredBySessionStartMatcher(matcher: string | undefined): readonly string[] {
  if (matcher === undefined || matcher.trim() === '') {
    return SESSION_START_SOURCES;
  }

  try {
    const expression = new RegExp(`^(?:${matcher})$`, 'u');
    return SESSION_START_SOURCES.filter((source) => expression.test(source));
  } catch {
    return [];
  }
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
      if (matcher.hooks === undefined) {
        return matcher;
      }
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
  if (typeof hook.command !== 'string') {
    return false;
  }
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
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

export function relativeHooksPath(projectRoot: string, hooksPath: string): string {
  return relative(projectRoot, hooksPath);
}
