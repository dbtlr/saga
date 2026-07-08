// SGA-249: the dual-role `saga doctor`. Client-role checks (environment, workspace
// binding, and — crucially — service reachability + migration state via the service's
// /v1/info, NOT a direct Postgres connection) are delegated to @saga/client-cli, the
// single source of truth for client functionality. On top of those, this appends the
// HOST-OPS checks a combined install still owns and the client binary cannot answer:
// the launchd service process state, the local embedding posture, and the ADR-0044
// convergence guide. No client-role path here opens Postgres.

import { join } from 'node:path';

import { doctorProject as clientDoctorProject } from '@saga/client-cli';
import type { ClientCommandContext, DoctorCheck, DoctorStatus } from '@saga/client-cli';
import type { MigrationStatus } from '@saga/db';
import {
  DATABASE_URL_ENV,
  findProjectRoot,
  inspectEmbeddingWorkflow,
  installationConfigLocation,
  loadRuntimeConfig,
} from '@saga/runtime';
import type {
  EmbeddingCredentialResolutionOptions,
  EmbeddingPolicyResolutionOptions,
  EmbeddingWorkflowBoundary,
  LoadRuntimeConfigOptions,
  RuntimeConfig,
} from '@saga/runtime';
import { Effect } from 'effect';

import { isCompiledBinary, stableBinPath } from './binary.js';
import { inspectHarnesses, staleHarnessReferences } from './harness.js';
import type { HarnessIntegrationState } from './harness.js';
import { formatCommandOutput } from './output.js';
import { recordBlock } from './render.js';
import type { RenderOptions } from './render.js';
import { inspectServiceStatus, launchdPointsAtCheckout } from './service.js';

// Re-exported for host-ops consumers (self-update's doctor-verify) that share the
// check vocabulary; the shape is identical to @saga/client-cli's.
export type { DoctorCheck, DoctorStatus } from '@saga/client-cli';

export async function runDoctor(
  _args: readonly string[],
  options: RenderOptions,
  context: ClientCommandContext = {},
): Promise<string> {
  const checks = await doctorProject(context);
  return formatCommandOutput(
    {
      id: 'doctor',
      records: renderDoctor(checks, options),
      value: checks,
    },
    options.format,
  );
}

export async function doctorProject(
  context: ClientCommandContext = {},
  input: {
    convergence?: { compiled?: boolean; home?: string };
    cwd?: string;
    embeddingAuth?: EmbeddingCredentialResolutionOptions;
    embeddingPolicy?: EmbeddingPolicyResolutionOptions;
    runtimeConfig?: Omit<LoadRuntimeConfigOptions, 'cwd'>;
  } = {},
): Promise<DoctorCheck[]> {
  const cwd = input.cwd ?? context.cwd ?? process.cwd();
  const projectRoot = findProjectRoot(cwd);

  // The client-role checks (environment, workspace binding, service reachability +
  // migrations + extraction over /v1/info) run concurrently with the launchd process
  // probe and the local DATABASE_URL config-source resolution — they are independent,
  // so a slow/unreachable service doesn't serialize their timeouts. None open Postgres.
  const [clientChecks, service, databaseConfig] = await Promise.all([
    clientDoctorProject(context, { cwd }),
    inspectService(),
    checkDatabaseConfig(projectRoot, input.runtimeConfig ?? {}),
  ]);

  // The combined-install doctor owns the RICHER harness diagnostic: the client doctor's
  // harness rows only test hook-file existence, so drop them and use the filesystem
  // divergence/staleness/mcp-drift check (no db) that flags a broken integration.
  const checks = clientChecks.filter((check) => !check.label.startsWith('harness'));

  checks.push(...checkHarnesses(projectRoot));
  // A HOST-OPS check: where the co-located service's DATABASE_URL resolves from
  // (ADR-0044/0038 precedence). It reads config only — it never opens a connection, so
  // no client-role Postgres access is introduced.
  checks.push(databaseConfig);
  checks.push({
    detail: `${service.process}; ${service.health}`,
    label: 'service process',
    status: serviceDoctorStatus(service),
  });
  checks.push(checkEmbeddings(input.embeddingAuth, input.embeddingPolicy));

  const convergence = checkConvergence(projectRoot, input.convergence);
  if (convergence !== undefined) {
    checks.push(convergence);
  }

  return checks;
}

// The FILESYSTEM harness integration state (no db, no activation evidence): flags a
// harness whose hook shim or `.mcp.json` entry has drifted (divergent/invalid/stale)
// as a failure, and a missing/divergent MCP entry as a warning — the diagnostic that
// surfaces silently-broken capture. Activation evidence (a db read) is deferred to the
// service (the client doctor notes it); this keeps the host-ops divergence signal.
function checkHarnesses(projectRoot: string): DoctorCheck[] {
  let statuses;
  try {
    statuses = inspectHarnesses({ cwd: projectRoot });
  } catch (error) {
    return [
      {
        detail: `skipped because harness state could not be read: ${error instanceof Error ? error.message : String(error)}`,
        label: 'harness',
        status: 'fail',
      },
    ];
  }
  return statuses.flatMap((harness) => {
    const checks: DoctorCheck[] = [
      {
        detail:
          harness.nextStep === undefined
            ? `${harness.state}; ${harness.stateDetail}`
            : `${harness.state}; ${harness.stateDetail}; next step: ${harness.nextStep}`,
        label: `harness:${harness.target}`,
        status: harnessDoctorStatus(harness.state),
      },
    ];
    if (
      harness.binding === 'installed' &&
      (harness.mcp === 'missing' || harness.mcp === 'divergent')
    ) {
      checks.push({
        detail: `${harness.mcp}; ${harness.mcpDetail}`,
        label: `harness:${harness.target}:mcp`,
        status: 'warn',
      });
    }
    return checks;
  });
}

function harnessDoctorStatus(state: HarnessIntegrationState): DoctorStatus {
  if (state === 'configured') {
    return 'ok';
  }
  if (state === 'divergent' || state === 'invalid' || state === 'stale') {
    return 'fail';
  }
  return 'warn';
}

// Report where DATABASE_URL resolves from (ADR-0044/0038 precedence), for the
// co-located service. loadRuntimeConfig reads env/config files only — it opens NO
// Postgres connection — so this stays a host-ops config check, not client-role db access.
async function checkDatabaseConfig(
  projectRoot: string,
  runtimeConfig: Omit<LoadRuntimeConfigOptions, 'cwd'>,
): Promise<DoctorCheck> {
  let config: RuntimeConfig;
  try {
    config = await Effect.runPromise(loadRuntimeConfig({ ...runtimeConfig, cwd: projectRoot }));
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      label: 'database config',
      status: 'fail',
    };
  }

  if (config.databaseUrlSource === 'missing') {
    const installationConfig = installationConfigLocation({
      env: runtimeConfig.env ?? process.env,
      ...(runtimeConfig.homeDir === undefined ? {} : { homeDir: runtimeConfig.homeDir }),
    });
    const guidance = `${DATABASE_URL_ENV} is not configured; set it in the environment, in ${join(projectRoot, '.env.local')}, or as database.url in ${installationConfig.displayPath}`;
    return {
      detail:
        config.installationConfigIssue === undefined
          ? guidance
          : `${guidance}; ${config.installationConfigIssue}`,
      label: 'database config',
      status: 'fail',
    };
  }

  const sourceDetail: Record<Exclude<RuntimeConfig['databaseUrlSource'], 'missing'>, string> = {
    environment: `${DATABASE_URL_ENV} from environment`,
    'installation-config': `${DATABASE_URL_ENV} from installation config`,
    'project-env-file': `${DATABASE_URL_ENV} from project env file`,
  };
  if (config.installationConfigIssue !== undefined) {
    return {
      detail: `${sourceDetail[config.databaseUrlSource]}; ${config.installationConfigIssue}`,
      label: 'database config',
      status: 'warn',
    };
  }
  return {
    detail: sourceDetail[config.databaseUrlSource],
    label: 'database config',
    status: 'ok',
  };
}

/**
 * The convergence guide (ADR-0044): when running as the installed compiled binary,
 * flag any integration reference (the Claude `.mcp.json` command, a hook shim, or
 * the launchd service plist) that still resolves to a checkout path instead of the
 * one stable install path, and name the command that fixes each. From source the
 * integrations are expected to point at the checkout, so the check is skipped.
 */
export function checkConvergence(
  projectRoot: string,
  options: { compiled?: boolean; home?: string } = {},
): DoctorCheck | undefined {
  const compiled = options.compiled ?? isCompiledBinary();
  if (!compiled) {
    return undefined;
  }

  const stable = options.home === undefined ? stableBinPath() : stableBinPath(options.home);
  const stale = staleHarnessReferences(projectRoot, options.home).map(
    (ref) => `${ref.label} (run: ${ref.fix})`,
  );
  if (launchdPointsAtCheckout(options.home)) {
    stale.push('launchd service (run: saga service install)');
  }

  if (stale.length === 0) {
    return {
      detail: `every integration reference resolves to ${stable}`,
      label: 'convergence',
      status: 'ok',
    };
  }
  return {
    detail: `checkout-pointing references: ${stale.join('; ')}`,
    label: 'convergence',
    status: 'warn',
  };
}

export function renderDoctor(checks: readonly DoctorCheck[], options: RenderOptions): string {
  return recordBlock(
    'Saga doctor',
    checks.map((check) => ({
      label: check.label,
      value: `${statusToken(check.status, options)} ${check.detail}`,
    })),
    options,
  );
}

async function inspectService(): Promise<{
  health: string;
  process: 'running' | 'not running';
}> {
  try {
    return await inspectServiceStatus();
  } catch (error) {
    return {
      health: error instanceof Error ? error.message : String(error),
      process: 'not running',
    };
  }
}

function checkEmbeddings(
  authOptions?: EmbeddingCredentialResolutionOptions,
  policyOptions?: EmbeddingPolicyResolutionOptions,
): DoctorCheck {
  const workflow = inspectEmbeddingWorkflow(authOptions, policyOptions);
  return {
    detail: renderEmbeddingWorkflow(workflow),
    label: 'embeddings',
    status: workflow.mode === 'vector-aware' ? 'ok' : 'warn',
  };
}

function renderEmbeddingWorkflow(workflow: EmbeddingWorkflowBoundary): string {
  const provider = `${workflow.provider.id}/${workflow.provider.model} (${String(workflow.provider.dimensions)} dimensions)`;
  const detail: Record<EmbeddingWorkflowBoundary['mode'], string> = {
    'vector-aware': `${provider} vector-aware; ${workflow.availability.credential.detail}; lexical fallback: ${workflow.lexicalFallback.state}`,
    'lexical-only-by-policy': `${provider} lexical-only by policy; ${workflow.policy.detail}; ${workflow.availability.guidance}`,
    'lexical-fallback': `${provider} lexical fallback; ${workflow.availability.credential.detail}; ${workflow.availability.guidance}`,
  };
  return detail[workflow.mode];
}

/**
 * Three-state migration report (ADR-0045) over an already-read MigrationStatus, kept
 * here for self-update's doctor-verify (which opens the db directly as a host-ops
 * migration step, not a client-role path): current is ok, behind fails and names
 * `saga self-update`, ahead warns, and a hash mismatch fails as an incompatibility.
 */
export function migrationDoctorCheck(status: MigrationStatus): DoctorCheck {
  if (status.mismatch !== undefined) {
    return {
      detail: `migration ${String(status.mismatch.index)} (${status.mismatch.tag}) does not match this Saga build — restore a compatible backup or run a matching Saga build`,
      label: 'migrations',
      status: 'fail',
    };
  }
  if (status.applied < status.expected) {
    return {
      detail: `${String(status.applied)}/${String(status.expected)} applied — database is behind this binary; run \`saga self-update\``,
      label: 'migrations',
      status: 'fail',
    };
  }
  if (status.applied > status.expected) {
    return {
      detail: `${String(status.applied)}/${String(status.expected)} applied — database is ahead of this binary; a newer saga exists, run \`saga self-update\``,
      label: 'migrations',
      status: 'warn',
    };
  }
  return {
    detail: `${String(status.applied)} applied`,
    label: 'migrations',
    status: 'ok',
  };
}

export function serviceDoctorStatus(service: {
  health: string;
  process: 'running' | 'not running';
}): DoctorStatus {
  return service.process === 'running' && service.health.startsWith('ok ') ? 'ok' : 'warn';
}

function statusToken(status: DoctorStatus, options: RenderOptions): string {
  if (options.ascii) {
    return `[${status}]`;
  }
  if (status === 'ok') {
    return '✓';
  }
  if (status === 'warn') {
    return '⚠';
  }
  return '✗';
}
