import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MigrationStatus } from '@saga/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RenderOptions } from './render.js';
import {
  assetName,
  compareSemver,
  parseSelfUpdateArgs,
  RELEASE_BASE,
  replaceBinary as replaceBinaryEngine,
  resolveLatestPrereleaseTag,
  resolveLatestTag,
  runSelfUpdateCommand,
  verifyChecksum,
} from './self-update.js';
import type { Fetcher, SelfUpdateDependencies } from './self-update.js';
import type { ServiceSupervisor, ServiceSupervisorInspection } from './service.js';

const options: RenderOptions = {
  ascii: true,
  color: 'never',
  format: 'records',
  isTty: false,
};

const currentStatus: MigrationStatus = {
  applied: 5,
  compatible: true,
  expected: 5,
  mismatch: undefined,
};

function redirect(location: string): Response {
  return new Response(null, { headers: { location }, status: 302 });
}

function ok(body: string | Uint8Array): Response {
  return new Response(body, { status: 200 });
}

function sumsFor(asset: string, body: Uint8Array): string {
  const hash = createHash('sha256').update(body).digest('hex');
  return `${hash}  ${asset}\nsomeotherhash  saga-linux-x64\n`;
}

type RouteOverrides = {
  atom?: string;
  body?: Uint8Array;
  sums?: string;
  tag?: string;
};

function releaseFetcher(overrides: RouteOverrides = {}): { calls: string[]; fetcher: Fetcher } {
  const tag = overrides.tag ?? 'v1.2.3';
  const body = overrides.body ?? new Uint8Array([1, 2, 3, 4]);
  const asset = 'saga-darwin-arm64';
  const sums = overrides.sums ?? sumsFor(asset, body);
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    if (url === `${RELEASE_BASE}/latest`) {
      return redirect(`https://github.com/dbtlr/saga/releases/tag/${tag}`);
    }
    if (url === `${RELEASE_BASE}.atom` || url.endsWith('releases.atom')) {
      return ok(overrides.atom ?? `<entry><link href="/dbtlr/saga/releases/tag/${tag}"/></entry>`);
    }
    if (url === `${RELEASE_BASE}/download/${tag}/${asset}`) {
      return ok(body);
    }
    if (url === `${RELEASE_BASE}/download/${tag}/SHA256SUMS`) {
      return ok(sums);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { calls, fetcher };
}

function fakeSupervisor(
  state: ServiceSupervisorInspection['state'],
  restart: () => Promise<void> = async () => undefined,
): { restarts: number; supervisor: ServiceSupervisor } {
  const box = { restarts: 0 };
  const supervisor = {
    inspect: async () => ({
      detail: 'test',
      logs: '',
      process: state === 'running' ? ('running' as const) : ('not running' as const),
      state,
    }),
    install: async () => {
      throw new Error('unused');
    },
    restart: async () => {
      box.restarts += 1;
      await restart();
      return {
        action: 'restart' as const,
        detail: 'restarted',
        label: 'com.saga.service',
        plistPath: '/tmp/x.plist',
        state: 'running' as const,
      };
    },
    start: async () => {
      throw new Error('unused');
    },
    stop: async () => {
      throw new Error('unused');
    },
    uninstall: async () => {
      throw new Error('unused');
    },
  } satisfies ServiceSupervisor;
  return {
    get restarts() {
      return box.restarts;
    },
    supervisor,
  };
}

function baseDeps(overrides: Partial<SelfUpdateDependencies> = {}): SelfUpdateDependencies {
  return {
    arch: 'arm64',
    argv1: '/$bunfs/root/saga',
    binPath: '/Users/x/.local/bin/saga',
    migrate: async () => currentStatus,
    platform: 'darwin',
    replaceBinary: () => undefined,
    version: '1.0.0',
    ...overrides,
  };
}

describe('compareSemver', () => {
  it('orders numeric triples and tolerates a leading v', () => {
    expect(compareSemver('v1.2.3', '1.2.2')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareSemver('0.9.0', '1.0.0')).toBeLessThan(0);
  });
});

describe('assetName', () => {
  it('names the platform asset', () => {
    expect(assetName('darwin', 'arm64')).toBe('saga-darwin-arm64');
    expect(assetName('linux', 'x64')).toBe('saga-linux-x64');
    expect(assetName('darwin', 'x64')).toBe('saga-darwin-x64');
  });
});

describe('replaceBinary', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'saga-replace-'));
    dirs.push(dir);
    return dir;
  };

  it('atomically swaps the target and leaves no staging file', () => {
    const target = join(tempDir(), 'saga');
    replaceBinaryEngine(target, new Uint8Array([1, 2, 3]));
    expect(readFileSync(target)).toStrictEqual(Buffer.from([1, 2, 3]));
    expect(existsSync(`${target}.self-update`)).toBe(false);
  });

  it('cleans up the staging file and rethrows when staging fails', () => {
    // A target inside a nonexistent directory makes the staging write fail.
    const target = join(tempDir(), 'missing', 'saga');
    expect(() => replaceBinaryEngine(target, new Uint8Array([1]))).toThrow(/ENOENT/u);
    expect(existsSync(`${target}.self-update`)).toBe(false);
  });
});

describe('verifyChecksum', () => {
  it('passes when the digest matches', () => {
    const body = new Uint8Array([9, 8, 7]);
    expect(() =>
      verifyChecksum(body, sumsFor('saga-darwin-arm64', body), 'saga-darwin-arm64'),
    ).not.toThrow();
  });

  it('fails closed when the digest mismatches', () => {
    const body = new Uint8Array([9, 8, 7]);
    const sums = sumsFor('saga-darwin-arm64', new Uint8Array([0, 0, 0]));
    expect(() => verifyChecksum(body, sums, 'saga-darwin-arm64')).toThrow(/checksum mismatch/u);
  });

  it('fails closed when there is no entry for the asset', () => {
    expect(() =>
      verifyChecksum(new Uint8Array([1]), 'abc  other-asset\n', 'saga-darwin-arm64'),
    ).toThrow(/no SHA256SUMS entry/u);
  });
});

describe('resolveLatestTag', () => {
  it('reads the tag from the releases/latest redirect', async () => {
    const { fetcher } = releaseFetcher({ tag: 'v2.0.1' });
    await expect(resolveLatestTag(fetcher)).resolves.toBe('v2.0.1');
  });

  it('throws when the redirect has no tag', async () => {
    const fetcher: Fetcher = async () => redirect('https://github.com/dbtlr/saga');
    await expect(resolveLatestTag(fetcher)).rejects.toThrow(/could not resolve/u);
  });
});

describe('resolveLatestPrereleaseTag', () => {
  it('reads the first tag from the atom feed', async () => {
    const fetcher: Fetcher = async () =>
      ok('<feed><entry><link href="/dbtlr/saga/releases/tag/v3.0.0-next.1"/></entry></feed>');
    await expect(resolveLatestPrereleaseTag(fetcher)).resolves.toBe('v3.0.0-next.1');
  });
});

describe('parseSelfUpdateArgs', () => {
  it('parses --next and --tag', () => {
    expect(parseSelfUpdateArgs(['--next'])).toStrictEqual({ next: true });
    expect(parseSelfUpdateArgs(['--tag', 'v1.2.3'])).toStrictEqual({ tag: 'v1.2.3' });
    expect(parseSelfUpdateArgs(['--tag=v1.2.3'])).toStrictEqual({ tag: 'v1.2.3' });
  });

  it('rejects unknown options and a missing tag value', () => {
    expect(() => parseSelfUpdateArgs(['--bogus'])).toThrow(/unknown option/u);
    expect(() => parseSelfUpdateArgs(['--tag'])).toThrow(/--tag expects a value/u);
  });
});

describe('runSelfUpdateCommand', () => {
  it('refuses to run from a source (non-compiled) process without touching anything', async () => {
    const replaceBinary = vi.fn();
    const { fetcher } = releaseFetcher();
    await expect(
      runSelfUpdateCommand([], options, () => undefined, {
        // A real filesystem argv[1] (not /$bunfs/) means a from-source run.
        argv1: '/Volumes/data/workspaces/saga/apps/cli/src/main.ts',
        fetcher,
        replaceBinary,
      }),
    ).rejects.toThrow(/running from source/u);
    expect(replaceBinary).not.toHaveBeenCalled();
  });

  it('no-ops when already up to date', async () => {
    const replaceBinary = vi.fn();
    const { fetcher } = releaseFetcher({ tag: 'v1.0.0' });
    const lines: string[] = [];
    const code = await runSelfUpdateCommand(
      [],
      options,
      (text) => lines.push(text),
      baseDeps({ fetcher, replaceBinary, version: '1.0.0' }),
    );
    expect(code).toBe(0);
    expect(replaceBinary).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('already up to date');
  });

  it('downloads, verifies, swaps, migrates, and restarts on the happy path', async () => {
    const body = new Uint8Array([5, 6, 7, 8]);
    const { fetcher } = releaseFetcher({ body, tag: 'v1.2.3' });
    const replaceBinary = vi.fn();
    const migrate = vi.fn(async () => currentStatus);
    const sup = fakeSupervisor('running');
    const lines: string[] = [];
    const code = await runSelfUpdateCommand(
      [],
      options,
      (text) => lines.push(text),
      baseDeps({ fetcher, migrate, replaceBinary, supervisor: sup.supervisor }),
    );
    expect(code).toBe(0);
    expect(replaceBinary).toHaveBeenCalledWith('/Users/x/.local/bin/saga', body);
    expect(migrate).toHaveBeenCalled();
    expect(sup.restarts).toBe(1);
    const output = lines.join('\n');
    expect(output).toContain('1.0.0 → 1.2.3');
    expect(output).toContain('restarted');
  });

  it('fails closed on a checksum mismatch and never swaps the binary', async () => {
    const { fetcher } = releaseFetcher({ sums: 'deadbeef  saga-darwin-arm64\n', tag: 'v1.2.3' });
    const replaceBinary = vi.fn();
    await expect(
      runSelfUpdateCommand([], options, () => undefined, baseDeps({ fetcher, replaceBinary })),
    ).rejects.toThrow(/checksum mismatch/u);
    expect(replaceBinary).not.toHaveBeenCalled();
  });

  it('treats a failed restart as a warning — the binary is already updated', async () => {
    const { fetcher } = releaseFetcher({ tag: 'v1.2.3' });
    const replaceBinary = vi.fn();
    const sup = fakeSupervisor('running', async () => {
      throw new Error('kickstart failed');
    });
    const lines: string[] = [];
    const code = await runSelfUpdateCommand(
      [],
      options,
      (text) => lines.push(text),
      baseDeps({ fetcher, replaceBinary, supervisor: sup.supervisor }),
    );
    expect(code).toBe(0);
    expect(replaceBinary).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('did not restart');
  });

  it('does not restart when the service is not installed', async () => {
    const { fetcher } = releaseFetcher({ tag: 'v1.2.3' });
    const sup = fakeSupervisor('not installed');
    const code = await runSelfUpdateCommand(
      [],
      options,
      () => undefined,
      baseDeps({ fetcher, supervisor: sup.supervisor }),
    );
    expect(code).toBe(0);
    expect(sup.restarts).toBe(0);
  });

  it('pins an explicit --tag', async () => {
    const { calls, fetcher } = releaseFetcher({ tag: 'v9.9.9' });
    const replaceBinary = vi.fn();
    await runSelfUpdateCommand(
      ['--tag', 'v9.9.9'],
      options,
      () => undefined,
      baseDeps({ fetcher, replaceBinary }),
    );
    expect(replaceBinary).toHaveBeenCalled();
    expect(calls).not.toContain(`${RELEASE_BASE}/latest`);
  });
});
