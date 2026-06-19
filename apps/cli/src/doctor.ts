import { execFileSync } from "node:child_process";
import { makeDatabase } from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { bindingPathFor, findProjectRoot, readBindingFile } from "./init.js";
import { recordBlock, type RenderOptions } from "./render.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  detail: string;
  label: string;
  status: DoctorStatus;
}

export async function runDoctor(_args: readonly string[], options: RenderOptions): Promise<string> {
  const checks = await doctorProject();
  return renderDoctor(checks, options);
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
  checks.push({
    detail: "foreground/status implementation lands in SGA-22",
    label: "service",
    status: "warn",
  });
  checks.push({
    detail: "codex/claude harness checks are placeholders",
    label: "harness",
    status: "warn",
  });

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
  const binding = readBindingFile(projectRoot);
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
      const migrations = await service.sql.unsafe(
        "select count(*)::text as count from drizzle.__drizzle_migrations",
      );
      const migrationCount = String(migrations[0]?.count ?? "0");
      return [
        {
          detail: "connected",
          label: "postgres",
          status: "ok",
        },
        {
          detail: `${migrationCount} applied`,
          label: "migrations",
          status: "ok",
        },
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

function statusToken(status: DoctorStatus, options: RenderOptions): string {
  if (options.ascii) return `[${status}]`;
  if (status === "ok") return "✓";
  if (status === "warn") return "⚠";
  return "✗";
}
