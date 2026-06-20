import { execFileSync } from "node:child_process";
import { getMigrationStatus, makeDatabase, type DatabaseService } from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { inspectHarnesses, type HarnessIntegrationState } from "./harness.js";
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

export async function doctorProject(input: { cwd?: string } = {}): Promise<DoctorCheck[]> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const checks: DoctorCheck[] = [
    {
      detail: process.versions.node,
      label: "node",
      status: "ok",
    },
    checkPnpm(),
    checkBinding(projectRoot),
  ];

  checks.push(...(await checkPostgres(projectRoot)));
  const service = await inspectService();
  checks.push({
    detail: `${service.process}; ${service.health}`,
    label: "service",
    status: service.process === "running" ? "ok" : "warn",
  });
  checks.push(...checkHarnesses(projectRoot));

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

function checkPnpm(): DoctorCheck {
  try {
    return {
      detail: execFileSync("pnpm", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
      label: "pnpm",
      status: "ok",
    };
  } catch {
    return {
      detail: "pnpm was not found on PATH",
      label: "pnpm",
      status: "fail",
    };
  }
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
    const migrationStatus = await Effect.runPromise(getMigrationStatus(service));
    if (migrationStatus.applied < migrationStatus.expected) {
      return {
        detail: `${String(migrationStatus.applied)} applied; expected ${String(migrationStatus.expected)}`,
        label: "migrations",
        status: "fail",
      };
    }

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

function checkHarnesses(projectRoot: string): DoctorCheck[] {
  try {
    return inspectHarnesses({ cwd: projectRoot }).map((harness) => ({
      detail: `${harness.state}; ${harness.stateDetail}`,
      label: `harness:${harness.target}`,
      status: harnessDoctorStatus(harness.state),
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

function harnessDoctorStatus(state: HarnessIntegrationState): DoctorStatus {
  if (state === "configured") return "ok";
  if (state === "divergent" || state === "invalid") return "fail";
  return "warn";
}

function statusToken(status: DoctorStatus, options: RenderOptions): string {
  if (options.ascii) return `[${status}]`;
  if (status === "ok") return "✓";
  if (status === "warn") return "⚠";
  return "✗";
}
