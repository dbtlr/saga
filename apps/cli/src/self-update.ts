/**
 * Self-update (SGA-223): resolve the latest release tag from the
 * releases/latest redirect (no GitHub API dependency), download the platform
 * asset, verify it against SHA256SUMS (hard fail), atomically replace our own
 * binary, then run pending migrations, restart the supervised service, and
 * doctor-verify. The fetch/verify/swap engine here is portable plain-IO; the
 * orchestration crosses into the Effect DB layer at its boundary. Refuses to
 * run from source — the swap target is `process.execPath`, which is only the
 * saga binary in a `bun --compile` build (ADR-0045, ADR-0044).
 */
import { createHash } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { makeDatabase, runMigrationsSafely } from '@saga/db';
import type { MigrationStatus } from '@saga/db';
import { loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { isRunningFromSource } from './binary.js';
import { migrationDoctorCheck } from './doctor.js';
import type { DoctorCheck, DoctorStatus } from './doctor.js';
import { findProjectRoot } from './init.js';
import { formatCommandOutput } from './output.js';
import { glyph, recordBlock } from './render.js';
import type { RenderOptions } from './render.js';
import { createLaunchdSupervisor } from './service.js';
import type { ServiceSupervisor } from './service.js';
import { VERSION } from './version.js';

export type Fetcher = (url: string) => Promise<Response>;

export const RELEASE_BASE = 'https://github.com/dbtlr/saga/releases';
export const ATOM_FEED = 'https://github.com/dbtlr/saga/releases.atom';

/** Default fetcher: never auto-follow — the redirect Location IS the answer. */
export const manualFetch: Fetcher = (url) => fetch(url, { redirect: 'manual' });

const parseSemverParts = (v: string): number[] =>
  v
    .replace(/^v/u, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);

/** Numeric triple compare; tolerates a leading `v`. <0 means a older than b. */
export function compareSemver(a: string, b: string): number {
  const [a0 = 0, a1 = 0, a2 = 0] = parseSemverParts(a);
  const [b0 = 0, b1 = 0, b2 = 0] = parseSemverParts(b);
  return a0 - b0 || a1 - b1 || a2 - b2;
}

export const stripV = (t: string): string => t.replace(/^v/u, '');

export async function resolveLatestTag(fetcher: Fetcher = manualFetch): Promise<string> {
  const res = await fetcher(`${RELEASE_BASE}/latest`);
  const location = res.headers.get('location') ?? '';
  const match = /\/releases\/tag\/(v[\d.]+)$/u.exec(location);
  if (match?.[1] === undefined) {
    throw new Error('could not resolve the latest release tag; check network access to github.com');
  }
  return match[1];
}

/**
 * The most recent release INCLUDING prereleases (the `--next` channel). GitHub's
 * `/releases/latest` excludes prereleases, so we read the atom feed instead —
 * newest-first, no auth, no REST rate limit. The first `/releases/tag/<tag>`
 * occurrence is the newest entry.
 */
export async function resolveLatestPrereleaseTag(fetcher: Fetcher = manualFetch): Promise<string> {
  const res = await fetcher(ATOM_FEED);
  const text = await res.text();
  const match = /\/releases\/tag\/([^"<]+)/u.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(
      'could not resolve a prerelease tag from the release feed; check network access to github.com',
    );
  }
  return match[1];
}

/** The release asset for this machine — same names install.sh downloads. */
export function assetName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const os = platform === 'darwin' ? 'darwin' : 'linux';
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  return `saga-${os}-${cpu}`;
}

export function verifyChecksum(body: Uint8Array, sums: string, asset: string): void {
  const line = sums.split('\n').find((entry) => entry.trim().endsWith(`  ${asset}`));
  if (line === undefined) {
    throw new Error(`no SHA256SUMS entry for ${asset}`);
  }
  const expected = line.trim().split(/\s+/u)[0];
  const actual = createHash('sha256').update(body).digest('hex');
  if (expected !== actual) {
    throw new Error(
      `checksum mismatch for ${asset} — the download is corrupt or tampered with; not installed`,
    );
  }
}

/** Write-beside + rename: the swap is atomic on the same filesystem. */
export function replaceBinary(targetPath: string, body: Uint8Array): void {
  const staging = `${targetPath}.self-update`;
  try {
    writeFileSync(staging, body);
    chmodSync(staging, 0o755);
  } catch (error) {
    // A failed stage must leave no litter beside the target; the rename (below)
    // is what makes the swap atomic, so nothing partial ever lands on target.
    rmSync(staging, { force: true });
    throw error;
  }
  renameSync(staging, targetPath);
}

export async function downloadAsset(
  tag: string,
  asset: string,
  fetcher: Fetcher = manualFetch,
): Promise<Uint8Array> {
  const res = await fetcher(`${RELEASE_BASE}/download/${tag}/${asset}`);
  const followed = await followDownload(res, fetcher);
  return new Uint8Array(await followed.arrayBuffer());
}

export async function downloadSums(tag: string, fetcher: Fetcher = manualFetch): Promise<string> {
  const res = await fetcher(`${RELEASE_BASE}/download/${tag}/SHA256SUMS`);
  return (await followDownload(res, fetcher)).text();
}

/** Release downloads 302 to a CDN URL; follow a few hops manually. */
async function followDownload(res: Response, fetcher: Fetcher): Promise<Response> {
  let current = res;
  for (let hops = 0; current.status >= 300 && current.status < 400 && hops < 5; hops += 1) {
    const next = current.headers.get('location');
    if (next === null) {
      break;
    }
    current = await fetcher(next);
  }
  if (!current.ok) {
    throw new Error(`release download failed (${String(current.status)})`);
  }
  return current;
}

export type SelfUpdateSelection = {
  next?: boolean;
  tag?: string | undefined;
};

export type MigrationState = 'ahead' | 'behind' | 'current' | 'mismatch' | 'unknown';

export type SelfUpdateResult = {
  asset: string;
  doctor: DoctorStatus;
  doctorDetail: string;
  from: string;
  migration: {
    applied: number;
    expected: number;
    state: MigrationState;
  };
  restartFailed: boolean;
  restarted: boolean;
  to: string;
  updated: boolean;
};

export type SelfUpdateDependencies = {
  arch?: NodeJS.Architecture | undefined;
  argv1?: string | undefined;
  binPath?: string | undefined;
  fetcher?: Fetcher | undefined;
  migrate?: (() => Promise<MigrationStatus>) | undefined;
  platform?: NodeJS.Platform | undefined;
  replaceBinary?: ((targetPath: string, body: Uint8Array) => void) | undefined;
  supervisor?: ServiceSupervisor | undefined;
  version?: string | undefined;
};

export function parseSelfUpdateArgs(args: readonly string[]): SelfUpdateSelection {
  const selection: SelfUpdateSelection = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--next') {
      selection.next = true;
      continue;
    }
    if (arg === '--tag') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error('--tag expects a value');
      }
      selection.tag = value;
      index += 1;
      continue;
    }
    const equals = /^--tag=(.+)$/u.exec(arg ?? '');
    if (equals?.[1] !== undefined) {
      selection.tag = equals[1];
      continue;
    }
    throw new Error(`unknown option: ${arg ?? ''}`);
  }
  return selection;
}

function migrationState(status: MigrationStatus): MigrationState {
  if (status.mismatch !== undefined) {
    return 'mismatch';
  }
  if (status.applied < status.expected) {
    return 'behind';
  }
  if (status.applied > status.expected) {
    return 'ahead';
  }
  return 'current';
}

async function resolveTarget(
  selection: SelfUpdateSelection,
  version: string,
  fetcher: Fetcher,
): Promise<{ alreadyCurrent: boolean; targetTag: string }> {
  if (selection.tag !== undefined) {
    const targetTag = selection.tag.startsWith('v') ? selection.tag : `v${selection.tag}`;
    return { alreadyCurrent: stripV(targetTag) === version, targetTag };
  }
  if (selection.next === true) {
    const targetTag = await resolveLatestPrereleaseTag(fetcher);
    return { alreadyCurrent: stripV(targetTag) === version, targetTag };
  }
  const targetTag = await resolveLatestTag(fetcher);
  return { alreadyCurrent: compareSemver(targetTag, version) <= 0, targetTag };
}

async function runMigrationStep(): Promise<MigrationStatus> {
  const config = await Effect.runPromise(
    loadRuntimeConfig({ cwd: findProjectRoot(process.cwd()) }),
  );
  const service = await Effect.runPromise(makeDatabase(config, { postgres: { max: 1 } }));
  try {
    return await Effect.runPromise(runMigrationsSafely(service));
  } finally {
    await Effect.runPromise(service.close());
  }
}

function isSupervisorLoaded(state: string): boolean {
  return state !== 'not installed' && state !== 'unavailable';
}

function serviceRestartSummary(restarted: boolean, restartFailed: boolean): string {
  if (restarted) {
    return 'restarted';
  }
  if (restartFailed) {
    return 'restart failed — run `saga service restart`';
  }
  return 'not restarted';
}

type ConvergenceOutcome = {
  doctor: DoctorCheck;
  migrateFailed: boolean;
  restartFailed: boolean;
  restarted: boolean;
  status: MigrationStatus | undefined;
};

/**
 * Run pending migrations, then restart the supervised service, then doctor-check
 * the schema (ADR-0045). Best-effort by construction — a migrate failure sets a
 * failing doctor state and is reported but never re-thrown, so a swapped binary
 * is never undone. Migrate is skipped-then-restart only when it succeeds: a
 * failed migrate leaves the service on the pre-migrate schema, and restarting
 * into the new binary would only make it refuse startup. Run in both the
 * already-current and post-swap paths so a prior half-finished update converges.
 */
async function convergeSchemaAndService(
  dependencies: SelfUpdateDependencies,
  platform: NodeJS.Platform,
  options: RenderOptions,
  write: (text: string) => void,
  structured: boolean,
): Promise<ConvergenceOutcome> {
  let status: MigrationStatus | undefined;
  let doctor: DoctorCheck;
  let migrateFailed = false;
  try {
    status = await (dependencies.migrate ?? runMigrationStep)();
    doctor = migrationDoctorCheck(status);
  } catch (error) {
    migrateFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    const detail = `migration failed: ${message} — re-run \`saga self-update\``;
    doctor = { detail, label: 'migrations', status: 'fail' };
    if (!structured) {
      write(`${glyph('warning', options)} ${detail}`);
    }
  }

  let restarted = false;
  let restartFailed = false;
  if (!migrateFailed && platform === 'darwin') {
    const supervisor = dependencies.supervisor ?? createLaunchdSupervisor();
    const inspection = await supervisor.inspect();
    if (isSupervisorLoaded(inspection.state)) {
      try {
        await supervisor.restart();
        restarted = true;
      } catch {
        restartFailed = true;
      }
    }
  }
  if (restartFailed && !structured) {
    write(
      `${glyph('warning', options)} service did not restart — run \`saga service restart\` (binary is updated)`,
    );
  }

  return { doctor, migrateFailed, restartFailed, restarted, status };
}

function selfUpdateResult(input: {
  asset: string;
  converged: ConvergenceOutcome;
  from: string;
  to: string;
  updated: boolean;
}): SelfUpdateResult {
  const { converged } = input;
  const migration =
    converged.status === undefined
      ? { applied: 0, expected: 0, state: 'unknown' as const }
      : {
          applied: converged.status.applied,
          expected: converged.status.expected,
          state: migrationState(converged.status),
        };
  return {
    asset: input.asset,
    doctor: converged.doctor.status,
    doctorDetail: converged.doctor.detail,
    from: input.from,
    migration,
    restartFailed: converged.restartFailed,
    restarted: converged.restarted,
    to: input.to,
    updated: input.updated,
  };
}

function renderSelfUpdate(result: SelfUpdateResult, options: RenderOptions): string {
  const header = result.updated
    ? [
        { label: 'updated', value: `${result.from} → ${result.to}` },
        { label: 'asset', value: result.asset },
      ]
    : [{ label: 'status', value: `already up to date (${result.from})` }];
  return formatCommandOutput(
    {
      id: 'self-update',
      records: recordBlock(
        'Saga self-update',
        [
          ...header,
          {
            label: 'migrations',
            value: `${String(result.migration.applied)}/${String(result.migration.expected)} applied (${result.migration.state})`,
          },
          {
            label: 'service',
            value: serviceRestartSummary(result.restarted, result.restartFailed),
          },
          { label: 'doctor', value: `migrations ${result.doctor}: ${result.doctorDetail}` },
        ],
        options,
      ),
      value: result,
    },
    options.format,
  );
}

export async function runSelfUpdateCommand(
  args: readonly string[],
  options: RenderOptions,
  write: (text: string) => void,
  dependencies: SelfUpdateDependencies = {},
): Promise<number> {
  const selection = parseSelfUpdateArgs(args);
  // Detect compiled-vs-source from argv[1] (fail-closed); the swap target below
  // stays process.execPath — the running binary.
  if (isRunningFromSource(dependencies.argv1)) {
    throw new Error(
      'self-update requires an installed saga binary; running from source — use git pull and `pnpm --filter @saga/service run migrate` instead',
    );
  }
  const binPath = dependencies.binPath ?? process.execPath;

  const fetcher = dependencies.fetcher ?? manualFetch;
  const version = dependencies.version ?? VERSION;
  const platform = dependencies.platform ?? process.platform;
  const asset = assetName(platform, dependencies.arch ?? process.arch);
  const structured = options.format === 'json' || options.format === 'jsonl';

  const { alreadyCurrent, targetTag } = await resolveTarget(selection, version, fetcher);
  const target = stripV(targetTag);

  if (alreadyCurrent) {
    // Already on the target version, but still converge: a prior run may have
    // swapped the binary and then failed to migrate, leaving this host stuck
    // binary-ahead-of-DB (the ADR-0045 incident class). Re-running recovers the
    // schema and reports the real DB state instead of a false "up to date".
    const converged = await convergeSchemaAndService(
      dependencies,
      platform,
      options,
      write,
      structured,
    );
    write(
      renderSelfUpdate(
        selfUpdateResult({ asset, converged, from: version, to: target, updated: false }),
        options,
      ),
    );
    return converged.migrateFailed ? 1 : 0;
  }

  if (!structured) {
    write(`updating ${version} → ${target} (${asset})`);
  }

  const [body, sums] = await Promise.all([
    downloadAsset(targetTag, asset, fetcher),
    downloadSums(targetTag, fetcher),
  ]);
  verifyChecksum(body, sums, asset);
  (dependencies.replaceBinary ?? replaceBinary)(binPath, body);

  // The binary is swapped; convergence is best-effort and must never re-throw.
  const converged = await convergeSchemaAndService(
    dependencies,
    platform,
    options,
    write,
    structured,
  );
  write(
    renderSelfUpdate(
      selfUpdateResult({ asset, converged, from: version, to: target, updated: true }),
      options,
    ),
  );
  // A failed post-swap migrate leaves the binary installed but the schema
  // unconverged — return non-zero so operators and automation notice.
  return converged.migrateFailed ? 1 : 0;
}
