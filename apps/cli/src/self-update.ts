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
import { chmodSync, renameSync, writeFileSync } from 'node:fs';

import { makeDatabase, runMigrationsSafely } from '@saga/db';
import type { MigrationStatus } from '@saga/db';
import { loadRuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';

import { isRunningFromSource } from './binary.js';
import { migrationDoctorCheck } from './doctor.js';
import type { DoctorStatus } from './doctor.js';
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
  writeFileSync(staging, body);
  chmodSync(staging, 0o755);
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

export type MigrationState = 'ahead' | 'behind' | 'current' | 'mismatch';

export type SelfUpdateResult = {
  asset: string;
  doctor: DoctorStatus;
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
    const result: SelfUpdateResult = {
      asset,
      doctor: 'ok',
      from: version,
      migration: { applied: 0, expected: 0, state: 'current' },
      restartFailed: false,
      restarted: false,
      to: target,
      updated: false,
    };
    write(
      formatCommandOutput(
        {
          id: 'self-update',
          records: recordBlock(
            'Saga self-update',
            [
              { label: 'status', value: `already up to date (${version})` },
              { label: 'version', value: version },
            ],
            options,
          ),
          value: result,
        },
        options.format,
      ),
    );
    return 0;
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

  // The binary is swapped; every step after this is best-effort convergence and
  // must not undo the install.
  const status = await (dependencies.migrate ?? runMigrationStep)();
  const doctor = migrationDoctorCheck(status);

  let restarted = false;
  let restartFailed = false;
  const supervisor = dependencies.supervisor ?? createLaunchdSupervisor();
  if (platform === 'darwin') {
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

  const result: SelfUpdateResult = {
    asset,
    doctor: doctor.status,
    from: version,
    migration: {
      applied: status.applied,
      expected: status.expected,
      state: migrationState(status),
    },
    restartFailed,
    restarted,
    to: target,
    updated: true,
  };

  write(
    formatCommandOutput(
      {
        id: 'self-update',
        records: recordBlock(
          'Saga self-update',
          [
            { label: 'updated', value: `${version} → ${target}` },
            { label: 'asset', value: asset },
            {
              label: 'migrations',
              value: `${String(status.applied)}/${String(status.expected)} applied (${migrationState(status)})`,
            },
            { label: 'service', value: serviceRestartSummary(restarted, restartFailed) },
            { label: 'doctor', value: `migrations ${doctor.status}: ${doctor.detail}` },
          ],
          options,
        ),
        value: result,
      },
      options.format,
    ),
  );
  return 0;
}
