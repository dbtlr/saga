import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertMigrationsCurrent, makeDatabase, type DatabaseService } from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import {
  inspectHarnessesWithActivation,
  type HarnessActivationState,
  type HarnessActivationVerifier,
  type HarnessIntegrationState,
} from "./harness.js";
import { bindingPathFor, findProjectRoot, readBindingFile } from "./init.js";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";
import { inspectServiceStatus } from "./service.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  detail: string;
  label: string;
  status: DoctorStatus;
}

export async function runDoctor(_args: readonly string[], options: RenderOptions): Promise<string> {
  const checks = await doctorProject();
  return formatCommandOutput(
    {
      id: "doctor",
      records: renderDoctor(checks, options),
      value: checks,
    },
    options.format,
  );
}

export async function doctorProject(
  input: {
    cwd?: string;
    verifyHarnessActivation?: HarnessActivationVerifier;
  } = {},
): Promise<DoctorCheck[]> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const checks: DoctorCheck[] = [
    checkNodeVersion(projectRoot),
    checkPnpm(projectRoot),
    checkBinding(projectRoot),
  ];

  checks.push(...(await checkPostgres(projectRoot)));
  const service = await inspectService();
  checks.push({
    detail: `${service.process}; ${service.health}`,
    label: "service",
    status: serviceDoctorStatus(service),
  });
  checks.push(...(await checkHarnesses(projectRoot, input.verifyHarnessActivation)));

  return checks;
}

export function renderDoctor(checks: readonly DoctorCheck[], options: RenderOptions): string {
  return recordBlock(
    "Saga doctor",
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
      label: "node",
      status: "warn",
    };
  }

  return {
    detail: `${version}; requires ${engine}`,
    label: "node",
    status: satisfiesEngineRange(version, engine) ? "ok" : "fail",
  };
}

function checkPnpm(projectRoot: string): DoctorCheck {
  const engine = readPackageEngines(projectRoot).pnpm;
  try {
    const version = execFileSync("pnpm", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return {
      detail:
        engine === undefined
          ? `${version}; no package.json engine declared`
          : `${version}; requires ${engine}`,
      label: "pnpm",
      status: engine === undefined || satisfiesEngineRange(version, engine) ? "ok" : "fail",
    };
  } catch {
    return {
      detail: "pnpm was not found on PATH",
      label: "pnpm",
      status: "fail",
    };
  }
}

function readPackageEngines(projectRoot: string): {
  node?: string | undefined;
  pnpm?: string | undefined;
} {
  try {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      engines?: {
        node?: unknown;
        pnpm?: unknown;
      };
    };
    return {
      node: typeof packageJson.engines?.node === "string" ? packageJson.engines.node : undefined,
      pnpm: typeof packageJson.engines?.pnpm === "string" ? packageJson.engines.pnpm : undefined,
    };
  } catch {
    return {};
  }
}

export function satisfiesEngineRange(version: string, range: string): boolean {
  return range
    .split(/\s+/u)
    .map((constraint) => constraint.trim())
    .filter((constraint) => constraint !== "")
    .every((constraint) => satisfiesVersionConstraint(version, constraint));
}

function satisfiesVersionConstraint(version: string, constraint: string): boolean {
  if (constraint.startsWith("^")) {
    const base = parseVersion(constraint.slice(1));
    const actual = parseVersion(version);
    return compareVersion(actual, base) >= 0 && actual.major === base.major;
  }

  const match = /^(>=|>|<=|<|=)?(.+)$/u.exec(constraint);
  if (match === null) return false;
  const operator = match[1] ?? "=";
  const comparison = compareVersion(parseVersion(version), parseVersion(match[2] ?? ""));
  if (operator === ">=") return comparison >= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === "<") return comparison < 0;
  return comparison === 0;
}

function parseVersion(value: string): { major: number; minor: number; patch: number } {
  const match = /^v?([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/u.exec(value.trim());
  if (match === null) return { major: 0, minor: 0, patch: 0 };
  return {
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
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
      label: "binding",
      status: "fail",
    };
  }

  if (binding === undefined) {
    return {
      detail: `missing ${bindingPathFor(projectRoot)}`,
      label: "binding",
      status: "warn",
    };
  }

  return {
    detail: `${binding.workspace.handle} (${binding.workspace.id})`,
    label: "binding",
    status: "ok",
  };
}

async function checkPostgres(projectRoot: string): Promise<DoctorCheck[]> {
  try {
    const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
    if (config.databaseUrl === undefined) {
      return [
        {
          detail: "DATABASE_URL is not set",
          label: "postgres",
          status: "warn",
        },
        {
          detail: "skipped because Postgres is not configured",
          label: "migrations",
          status: "warn",
        },
      ];
    }

    const service = await Effect.runPromise(makeDatabase(config));
    try {
      await service.sql`select 1`;
      const migrationCheck = await checkMigrations(service);
      return [
        {
          detail: "connected",
          label: "postgres",
          status: "ok",
        },
        migrationCheck,
      ];
    } finally {
      await Effect.runPromise(service.close());
    }
  } catch (error) {
    return [
      {
        detail: error instanceof Error ? error.message : String(error),
        label: "postgres",
        status: "fail",
      },
      {
        detail: "skipped because Postgres check failed",
        label: "migrations",
        status: "warn",
      },
    ];
  }
}

async function checkMigrations(service: DatabaseService): Promise<DoctorCheck> {
  try {
    const migrationStatus = await Effect.runPromise(assertMigrationsCurrent(service));
    return {
      detail: `${String(migrationStatus.applied)} applied`,
      label: "migrations",
      status: "ok",
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      label: "migrations",
      status: "fail",
    };
  }
}

async function inspectService(): Promise<{
  health: string;
  process: "running" | "not running";
}> {
  try {
    return await inspectServiceStatus();
  } catch (error) {
    return {
      health: error instanceof Error ? error.message : String(error),
      process: "not running",
    };
  }
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
    return statuses.map((harness) => ({
      detail:
        harness.nextStep === undefined
          ? `${harness.state}; ${harness.stateDetail}; activation: ${harness.activation.state}; ${harness.activation.detail}`
          : `${harness.state}; ${harness.stateDetail}; activation: ${harness.activation.state}; ${harness.activation.detail}; next step: ${harness.nextStep}`,
      label: `harness:${harness.target}`,
      status: harnessDoctorStatus(harness.state, harness.activation.state),
    }));
  } catch (error) {
    return [
      {
        detail: `skipped because harness state could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        label: "harness",
        status: "fail",
      },
    ];
  }
}

export function serviceDoctorStatus(service: {
  health: string;
  process: "running" | "not running";
}): DoctorStatus {
  return service.process === "running" && service.health.startsWith("ok ") ? "ok" : "warn";
}

function harnessDoctorStatus(
  state: HarnessIntegrationState,
  _activation: HarnessActivationState,
): DoctorStatus {
  if (state === "configured") return "ok";
  if (state === "divergent" || state === "invalid" || state === "stale") return "fail";
  return "warn";
}

function statusToken(status: DoctorStatus, options: RenderOptions): string {
  if (options.ascii) return `[${status}]`;
  if (status === "ok") return "✓";
  if (status === "warn") return "⚠";
  return "✗";
}
