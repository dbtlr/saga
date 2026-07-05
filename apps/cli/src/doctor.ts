import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getMigrationStatus, makeDatabase } from '@saga/db';
import type { DatabaseService, MigrationStatus } from '@saga/db';
import {
  DATABASE_URL_ENV,
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

import { inspectHarnessesWithActivation } from './harness.js';
import type {
  HarnessActivationState,
  HarnessActivationVerifier,
  HarnessIntegrationState,
} from './harness.js';
import { bindingPathFor, findProjectRoot, readBindingFile } from './init.js';
import { formatCommandOutput } from './output.js';
import { recordBlock } from './render.js';
import type { RenderOptions } from './render.js';
import { inspectServiceStatus } from './service.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export type DoctorCheck = {
  detail: string;
  label: string;
  status: DoctorStatus;
};

export async function runDoctor(_args: readonly string[], options: RenderOptions): Promise<string> {
  const checks = await doctorProject();
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
  input: {
    cwd?: string;
    embeddingAuth?: EmbeddingCredentialResolutionOptions;
    embeddingPolicy?: EmbeddingPolicyResolutionOptions;
    runtimeConfig?: Omit<LoadRuntimeConfigOptions, 'cwd'>;
    verifyHarnessActivation?: HarnessActivationVerifier;
  } = {},
): Promise<DoctorCheck[]> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const checks: DoctorCheck[] = [
    checkNodeVersion(projectRoot),
    checkBun(projectRoot),
    checkBinding(projectRoot),
  ];

  checks.push(...(await checkPostgres(projectRoot, input.runtimeConfig ?? {})));
  const service = await inspectService();
  checks.push({
    detail: `${service.process}; ${service.health}`,
    label: 'service',
    status: serviceDoctorStatus(service),
  });
  checks.push(checkEmbeddings(input.embeddingAuth, input.embeddingPolicy));
  checks.push(...(await checkHarnesses(projectRoot, input.verifyHarnessActivation)));

  return checks;
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

export function checkNodeVersion(
  projectRoot: string,
  version = process.versions.node,
): DoctorCheck {
  const engine = readPackageEngines(projectRoot).node;
  if (engine === undefined) {
    return {
      detail: `${version}; no package.json engine declared`,
      label: 'node',
      status: 'warn',
    };
  }

  return {
    detail: `${version}; requires ${engine}`,
    label: 'node',
    status: satisfiesEngineRange(version, engine) ? 'ok' : 'fail',
  };
}

function checkBun(projectRoot: string): DoctorCheck {
  const engine = readPackageEngines(projectRoot).bun;
  try {
    const version = execFileSync('bun', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return {
      detail:
        engine === undefined
          ? `${version}; no package.json engine declared`
          : `${version}; requires ${engine}`,
      label: 'bun',
      status: engine === undefined || satisfiesEngineRange(version, engine) ? 'ok' : 'fail',
    };
  } catch {
    return {
      detail: 'bun was not found on PATH',
      label: 'bun',
      status: 'fail',
    };
  }
}

function readPackageEngines(projectRoot: string): {
  bun?: string | undefined;
  node?: string | undefined;
} {
  try {
    // Boundary: package.json is external JSON; assert only a maximally-loose
    // shape (unknown leaves) and validate each field's type below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- external JSON; leaves are unknown and type-checked below
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      engines?: {
        bun?: unknown;
        node?: unknown;
      };
    };
    return {
      bun: typeof packageJson.engines?.bun === 'string' ? packageJson.engines.bun : undefined,
      node: typeof packageJson.engines?.node === 'string' ? packageJson.engines.node : undefined,
    };
  } catch {
    return {};
  }
}

export function satisfiesEngineRange(version: string, range: string): boolean {
  return range
    .split(/\s+/u)
    .map((constraint) => constraint.trim())
    .filter((constraint) => constraint !== '')
    .every((constraint) => satisfiesVersionConstraint(version, constraint));
}

function satisfiesVersionConstraint(version: string, constraint: string): boolean {
  if (constraint.startsWith('^')) {
    const base = parseVersion(constraint.slice(1));
    const actual = parseVersion(version);
    return compareVersion(actual, base) >= 0 && actual.major === base.major;
  }

  const match = /^(>=|>|<=|<|=)?(.+)$/u.exec(constraint);
  if (match === null) {
    return false;
  }
  const operator = match[1] ?? '=';
  const comparison = compareVersion(parseVersion(version), parseVersion(match[2] ?? ''));
  if (operator === '>=') {
    return comparison >= 0;
  }
  if (operator === '>') {
    return comparison > 0;
  }
  if (operator === '<=') {
    return comparison <= 0;
  }
  if (operator === '<') {
    return comparison < 0;
  }
  return comparison === 0;
}

function parseVersion(value: string): { major: number; minor: number; patch: number } {
  const match = /^v?([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/u.exec(value.trim());
  if (match === null) {
    return { major: 0, minor: 0, patch: 0 };
  }
  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt(match[2] ?? '0', 10),
    patch: Number.parseInt(match[3] ?? '0', 10),
  };
}

function compareVersion(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function checkBinding(projectRoot: string): DoctorCheck {
  let binding;
  try {
    binding = readBindingFile(projectRoot);
  } catch (error) {
    return {
      detail: `invalid ${bindingPathFor(projectRoot)}: ${error instanceof Error ? error.message : String(error)}`,
      label: 'binding',
      status: 'fail',
    };
  }

  if (binding === undefined) {
    return {
      detail: `missing ${bindingPathFor(projectRoot)}`,
      label: 'binding',
      status: 'warn',
    };
  }

  return {
    detail: `${binding.workspace.handle} (${binding.workspace.id})`,
    label: 'binding',
    status: 'ok',
  };
}

async function checkPostgres(
  projectRoot: string,
  runtimeConfig: Omit<LoadRuntimeConfigOptions, 'cwd'>,
): Promise<DoctorCheck[]> {
  let config: RuntimeConfig;
  try {
    config = await Effect.runPromise(loadRuntimeConfig({ ...runtimeConfig, cwd: projectRoot }));
  } catch (error) {
    return [
      {
        detail: error instanceof Error ? error.message : String(error),
        label: 'postgres',
        status: 'fail',
      },
      {
        detail: 'skipped because Postgres check failed',
        label: 'migrations',
        status: 'warn',
      },
    ];
  }

  const checks: DoctorCheck[] = [checkDatabaseConfig(config, projectRoot, runtimeConfig)];
  if (config.databaseUrl === undefined) {
    return [
      ...checks,
      {
        detail: `${DATABASE_URL_ENV} is not set`,
        label: 'postgres',
        status: 'warn',
      },
      {
        detail: 'skipped because Postgres is not configured',
        label: 'migrations',
        status: 'warn',
      },
    ];
  }

  try {
    const service = await Effect.runPromise(makeDatabase(config));
    try {
      await service.sql`select 1`;
      const migrationCheck = await checkMigrations(service);
      return [
        ...checks,
        {
          detail: 'connected',
          label: 'postgres',
          status: 'ok',
        },
        migrationCheck,
      ];
    } finally {
      await Effect.runPromise(service.close());
    }
  } catch (error) {
    return [
      ...checks,
      {
        detail: error instanceof Error ? error.message : String(error),
        label: 'postgres',
        status: 'fail',
      },
      {
        detail: 'skipped because Postgres check failed',
        label: 'migrations',
        status: 'warn',
      },
    ];
  }
}

function checkDatabaseConfig(
  config: RuntimeConfig,
  projectRoot: string,
  runtimeConfig: Omit<LoadRuntimeConfigOptions, 'cwd'>,
): DoctorCheck {
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
 * Three-state migration report (ADR-0045): current is ok, behind fails and
 * names `saga self-update` as the remedy, ahead warns (a newer saga exists —
 * each host's next doctor glance is the fleet's convergence nudge), and a hash
 * mismatch in the shared prefix fails as a genuine incompatibility. Pure over
 * an already-read status so self-update's doctor-verify can reuse it.
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

async function checkMigrations(service: DatabaseService): Promise<DoctorCheck> {
  try {
    const status = await Effect.runPromise(getMigrationStatus(service));
    return migrationDoctorCheck(status);
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      label: 'migrations',
      status: 'fail',
    };
  }
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

async function checkHarnesses(
  projectRoot: string,
  verifyActivation?: HarnessActivationVerifier,
): Promise<DoctorCheck[]> {
  try {
    const statuses = await inspectHarnessesWithActivation(
      verifyActivation === undefined
        ? { cwd: projectRoot }
        : { cwd: projectRoot, verifyActivation },
    );
    return statuses.flatMap((harness) => {
      const checks: DoctorCheck[] = [
        {
          detail:
            harness.nextStep === undefined
              ? `${harness.state}; ${harness.stateDetail}; activation: ${harness.activation.state}; ${harness.activation.detail}`
              : `${harness.state}; ${harness.stateDetail}; activation: ${harness.activation.state}; ${harness.activation.detail}; next step: ${harness.nextStep}`,
          label: `harness:${harness.target}`,
          status: harnessDoctorStatus(harness.state, harness.activation.state),
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
  } catch (error) {
    return [
      {
        detail: `skipped because harness state could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        label: 'harness',
        status: 'fail',
      },
    ];
  }
}

export function serviceDoctorStatus(service: {
  health: string;
  process: 'running' | 'not running';
}): DoctorStatus {
  return service.process === 'running' && service.health.startsWith('ok ') ? 'ok' : 'warn';
}

function harnessDoctorStatus(
  state: HarnessIntegrationState,
  _activation: HarnessActivationState,
): DoctorStatus {
  if (state === 'configured') {
    return 'ok';
  }
  if (state === 'divergent' || state === 'invalid' || state === 'stale') {
    return 'fail';
  }
  return 'warn';
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
