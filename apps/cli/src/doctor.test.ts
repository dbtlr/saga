import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SagaApiClient, ServiceInfo } from '@saga/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkConvergence,
  doctorProject,
  migrationDoctorCheck,
  renderDoctor,
  runDoctor,
  serviceDoctorStatus,
} from './doctor.js';
import type { DoctorCheck } from './doctor.js';

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Pin the installation config to an empty temp home so doctor checks never read the
// developer's real ~/.saga/config.json.
let previousSagaHome: string | undefined;
beforeAll(() => {
  previousSagaHome = process.env.SAGA_HOME;
  process.env.SAGA_HOME = mkdtempSync(join(tmpdir(), 'saga-doctor-saga-home-'));
});

afterAll(() => {
  if (previousSagaHome === undefined) {
    delete process.env.SAGA_HOME;
  } else {
    process.env.SAGA_HOME = previousSagaHome;
  }
});

// A stand-in service that answers /v1/info, so the delegated client reachability
// check resolves without a live service.
function fakeClient(info: Partial<ServiceInfo> = {}): SagaApiClient {
  const full: ServiceInfo = {
    extraction: {
      derivationFailed: 0,
      derivationPending: 0,
      settlementFailed: 0,
      settlementPending: 0,
    },
    migrations: { applied: 4, compatible: true, expected: 4 },
    uptimeSeconds: 12,
    version: '0.1.0',
    ...info,
  } as ServiceInfo;
  return { info: async () => full } as unknown as SagaApiClient;
}

describe('doctorProject (dual-role: client checks + host-ops)', () => {
  it('reports Node/bun env, the delegated service reachability, and the host-ops additions', async () => {
    const checks = await doctorProject(
      { client: fakeClient() },
      { convergence: { compiled: false }, cwd: workspaceRoot },
    );
    const labels = checks.map((check) => check.label);

    // Client-role checks delegated to @saga/client-cli (no Postgres opened here).
    expect(labels).toContain('node');
    expect(labels).toContain('bun');
    expect(labels).toContain('service'); // /v1/info reachability
    expect(labels).toContain('migrations'); // from the service report, not a local db
    // Host-ops additions this dual-role doctor layers on.
    expect(labels).toContain('service process');
    expect(labels).toContain('embeddings');

    // The service reachability reports the fake service as healthy.
    expect(checks).toContainEqual(expect.objectContaining({ label: 'service', status: 'ok' }));
  });

  it('appends the convergence guide only when running as a compiled binary', async () => {
    const home = mkdtempSync(join(tmpdir(), 'saga-doctor-home-'));
    const withConvergence = await doctorProject(
      { client: fakeClient() },
      { convergence: { compiled: true, home }, cwd: workspaceRoot },
    );
    expect(withConvergence.map((check) => check.label)).toContain('convergence');

    const withoutConvergence = await doctorProject(
      { client: fakeClient() },
      { convergence: { compiled: false }, cwd: workspaceRoot },
    );
    expect(withoutConvergence.map((check) => check.label)).not.toContain('convergence');
  });

  it('surfaces the service migration state from the report (behind → fail)', async () => {
    const checks = await doctorProject(
      { client: fakeClient({ migrations: { applied: 3, compatible: true, expected: 4 } }) },
      { convergence: { compiled: false }, cwd: workspaceRoot },
    );
    expect(checks).toContainEqual(expect.objectContaining({ label: 'migrations', status: 'fail' }));
  });
});

describe('runDoctor', () => {
  it('renders json output', async () => {
    const output = await runDoctor(
      [],
      { ascii: true, color: 'never', format: 'json', isTty: false },
      { client: fakeClient() },
    );
    expect(Array.isArray(JSON.parse(output))).toBe(true);
  });
});

describe('renderDoctor', () => {
  const fixtureChecks: DoctorCheck[] = [
    { detail: 'healthy at http://127.0.0.1:4766', label: 'service', status: 'ok' },
    { detail: 'not running; unreachable', label: 'service process', status: 'warn' },
    { detail: 'connection refused', label: 'migrations', status: 'fail' },
  ];

  it('renders unicode status tokens', () => {
    expect(
      renderDoctor(fixtureChecks, {
        ascii: false,
        color: 'never',
        format: 'records',
        isTty: false,
      }),
    ).toContain('⚠ not running');
  });

  it('renders ascii status tokens', () => {
    const rendered = renderDoctor(fixtureChecks, {
      ascii: true,
      color: 'never',
      format: 'records',
      isTty: false,
    });
    expect(rendered).toContain('[fail] connection refused');
    expect(rendered).toContain('[ok]');
  });
});

// The migration three-state is kept in apps/cli for self-update's doctor-verify
// (a host-ops migration step that opens the db directly, not a client-role path).
describe('migrationDoctorCheck', () => {
  it('is ok when applied equals expected', () => {
    expect(migrationDoctorCheck({ applied: 4, expected: 4 } as never).status).toBe('ok');
  });

  it('fails when the database is behind the binary and names self-update', () => {
    const check = migrationDoctorCheck({ applied: 3, expected: 4 } as never);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('saga self-update');
  });

  it('warns when the database is ahead of the binary', () => {
    expect(migrationDoctorCheck({ applied: 5, expected: 4 } as never).status).toBe('warn');
  });

  it('fails on a hash mismatch in the shared prefix', () => {
    const check = migrationDoctorCheck({
      applied: 4,
      expected: 4,
      mismatch: { index: 2, tag: 'add-embeddings' },
    } as never);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('does not match this Saga build');
  });
});

describe('checkConvergence', () => {
  it('is skipped (undefined) from source', () => {
    expect(checkConvergence(workspaceRoot, { compiled: false })).toBeUndefined();
  });

  it('reports ok when no integration reference points at a checkout', () => {
    // An isolated project + home with no harness shims or launchd plist, so nothing
    // resolves to a checkout path and the guide is clean.
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-doctor-conv-proj-'));
    const home = mkdtempSync(join(tmpdir(), 'saga-doctor-conv-home-'));
    const check = checkConvergence(projectRoot, { compiled: true, home });
    expect(check?.label).toBe('convergence');
    expect(check?.status).toBe('ok');
  });
});

describe('serviceDoctorStatus', () => {
  it('is ok only when the process is running and health starts with ok', () => {
    expect(serviceDoctorStatus({ health: 'ok healthy', process: 'running' })).toBe('ok');
    expect(serviceDoctorStatus({ health: 'ok healthy', process: 'not running' })).toBe('warn');
    expect(serviceDoctorStatus({ health: 'unreachable', process: 'running' })).toBe('warn');
  });
});
