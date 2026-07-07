import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SagaApiError } from '@saga/api-client';
import type { ExtractionBacklog, ServiceInfo } from '@saga/api-client';
import { findProjectRoot } from '@saga/runtime';

import { readBindingFile } from './binding.js';
import { resolveServiceUrl } from './client.js';
import { resolveClient } from './command-context.js';
import type { ClientCommandContext } from './command-context.js';
import type { ClientConfigResolutionOptions } from './config.js';
import { resolveWorkspaceBinding } from './config.js';
import { formatCommandOutput } from './output.js';
import { glyph, recordBlock } from './render.js';
import type { RenderOptions, Severity } from './render.js';

// The client-role doctor (SGA-239 slice 4). A client binary has no DATABASE_URL
// and does not manage the service process, so this answers "is my environment
// sane and can I reach a healthy service?" — NOT "is my Postgres up?". The pure
// fs/version checks (node/bun/binding) are ported from apps/cli/src/doctor.ts;
// the db/server-role checks (checkPostgres, inspectService, checkEmbeddings,
// checkConvergence) are replaced by ONE service reachability check over
// @saga/api-client's info(), which the boundary guard requires (no @saga/db).

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export type DoctorCheck = {
  detail: string;
  label: string;
  status: DoctorStatus;
};

const STATUS_SEVERITY: Record<DoctorStatus, Severity> = {
  fail: 'error',
  ok: 'success',
  warn: 'warning',
};

export type DoctorProjectOptions = {
  // Working directory for the environment checks (node/bun/binding). Defaults to
  // context.cwd, then process.cwd().
  cwd?: string | undefined;
  // Config resolution seam forwarded to the binding lookup (test injection).
  configOptions?: ClientConfigResolutionOptions | undefined;
};

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
  input: DoctorProjectOptions = {},
): Promise<DoctorCheck[]> {
  const cwd = input.cwd ?? context.cwd ?? process.cwd();
  const projectRoot = findProjectRoot(cwd);
  const checks: DoctorCheck[] = [
    checkNodeVersion(projectRoot),
    checkBun(projectRoot),
    checkBinding(cwd, input.configOptions),
  ];
  checks.push(...(await checkService(context)));
  checks.push(...checkHarnesses(projectRoot));
  return checks;
}

export function renderDoctor(checks: readonly DoctorCheck[], options: RenderOptions): string {
  return recordBlock(
    'Saga doctor',
    checks.map((check) => ({
      label: check.label,
      value: `${glyph(STATUS_SEVERITY[check.status], options)} ${check.detail}`,
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

// The binding check uses the CLIENT config seam (resolveWorkspaceBinding over
// ~/.saga/config.json's workspaces map, falling back to the per-repo
// .saga.local.json) instead of apps/cli's db-backed init binding.
function checkBinding(cwd: string, configOptions?: ClientConfigResolutionOptions): DoctorCheck {
  const resolved = resolveWorkspaceBinding(cwd, configOptions ?? {});
  if (resolved.source === 'client-config') {
    return {
      detail: `${resolved.binding.workspaceId} (client config)`,
      label: 'binding',
      status: 'ok',
    };
  }
  if (resolved.source === 'binding-file') {
    return {
      detail: `${resolved.binding.workspace.handle} (${resolved.binding.workspace.id})`,
      label: 'binding',
      status: 'ok',
    };
  }
  return {
    detail: `no workspace bound for ${cwd}; run \`saga init\` or configure a workspace`,
    label: 'binding',
    status: 'warn',
  };
}

// The client's core health signal: reach the service and read its /v1/info.
// Reachable + healthy -> ok (reporting version + uptime), plus the migration
// three-state and the extraction backlog derived from info(). A connection or
// timeout error (SagaApiError with status 0) -> a clear "service unreachable"
// error; any other non-2xx -> a service-error check. When no URL is configured,
// resolveClient throws and its message becomes the fail detail.
async function checkService(context: ClientCommandContext): Promise<DoctorCheck[]> {
  let target: string;
  try {
    target = resolveServiceUrl(context.apiClient ?? {});
  } catch {
    target = 'the configured service';
  }

  let client;
  try {
    client = resolveClient(context);
  } catch (error) {
    return [
      {
        detail: error instanceof Error ? error.message : String(error),
        label: 'service',
        status: 'fail',
      },
    ];
  }

  let info: ServiceInfo;
  try {
    info = await client.info();
  } catch (error) {
    if (error instanceof SagaApiError) {
      return [
        {
          detail:
            error.status === 0
              ? `service unreachable at ${target}: ${error.message}`
              : `service at ${target} returned an error (${error.code}): ${error.message}`,
          label: 'service',
          status: 'fail',
        },
      ];
    }
    return [
      {
        detail: error instanceof Error ? error.message : String(error),
        label: 'service',
        status: 'fail',
      },
    ];
  }

  return [
    {
      detail: `healthy at ${target}; version ${info.version}, uptime ${formatUptime(info.uptimeSeconds)}`,
      label: 'service',
      status: 'ok',
    },
    serviceMigrationCheck(info.migrations),
    serviceExtractionCheck(info.extraction),
  ];
}

/**
 * The migration three-state mapped from the service's /v1/info report (the
 * client has no local database to inspect, so it surfaces the SERVICE's own
 * assessment): `compatible === false` fails as a genuine incompatibility
 * (mirrors apps/cli's mismatch branch), applied < expected fails (the service
 * database is behind its build), applied > expected warns (ahead), and an
 * exact match is ok. Pure over the wire shape so it is unit-testable without a
 * live service.
 */
export function serviceMigrationCheck(migrations: ServiceInfo['migrations']): DoctorCheck {
  const applied = `${String(migrations.applied)}/${String(migrations.expected)} applied`;
  if (!migrations.compatible) {
    return {
      detail: `${applied} — service database is incompatible with the service build`,
      label: 'migrations',
      status: 'fail',
    };
  }
  if (migrations.applied < migrations.expected) {
    return {
      detail: `${applied} — service database is behind its build`,
      label: 'migrations',
      status: 'fail',
    };
  }
  if (migrations.applied > migrations.expected) {
    return {
      detail: `${applied} — service database is ahead of its build`,
      label: 'migrations',
      status: 'warn',
    };
  }
  return { detail: applied, label: 'migrations', status: 'ok' };
}

// The extraction backlog from /v1/info: pending work is informational, but any
// dead-lettered (failed after the attempt cap) job warns.
export function serviceExtractionCheck(backlog: ExtractionBacklog): DoctorCheck {
  const pending = backlog.derivationPending + backlog.settlementPending;
  const failed = backlog.derivationFailed + backlog.settlementFailed;
  return {
    detail:
      `${String(pending)} pending, ${String(failed)} dead-lettered ` +
      `(derivation ${String(backlog.derivationPending)}/${String(backlog.derivationFailed)}, ` +
      `settlement ${String(backlog.settlementPending)}/${String(backlog.settlementFailed)})`,
    label: 'extraction',
    status: failed > 0 ? 'warn' : 'ok',
  };
}

// The FILESYSTEM harness-install state, read from the per-repo binding file's
// `harnesses` map (the hook shim + its recorded path). The db activation-evidence
// query (apps/cli's listHarnessActivationRawEvents) is db-only with no client
// endpoint, so it is deferred rather than faked — noted in the detail. Returns no
// checks when there is no binding or no recorded harnesses (the `binding` check
// already reports binding presence).
function checkHarnesses(projectRoot: string): DoctorCheck[] {
  let binding;
  try {
    binding = readBindingFile(projectRoot);
  } catch {
    return [
      {
        detail: 'skipped because the binding file could not be read',
        label: 'harness',
        status: 'warn',
      },
    ];
  }
  const harnesses = binding?.harnesses;
  if (harnesses === undefined) {
    return [];
  }
  const checks: DoctorCheck[] = [];
  for (const harness of Object.values(harnesses)) {
    if (harness === undefined) {
      continue;
    }
    const present = existsSync(harness.hooksPath);
    checks.push({
      detail: present
        ? `installed ${harness.installedAt}; hooks at ${harness.hooksPath}; activation evidence deferred (no client endpoint)`
        : `hooks path missing: ${harness.hooksPath}; run \`saga harness install ${harness.target}\``,
      label: `harness:${harness.target}`,
      status: present ? 'ok' : 'warn',
    });
  }
  return checks;
}

function formatUptime(seconds: number): string {
  return `${String(Math.floor(seconds))}s`;
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
