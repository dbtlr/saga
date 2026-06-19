import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileActiveContext, type ActiveContextDocument } from "@saga/active-context";
import {
  listCurrentClaims,
  listRecentRawEvents,
  makeDatabase,
  workspaceProfiles,
  type CurrentClaim,
} from "@saga/db";
import { loadRuntimeConfig, type SagaEnvironment } from "@saga/runtime";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

const BINDING_FILE_NAME = ".saga.local.json";

export type ControlPlaneStatus = "misconfigured" | "offline" | "ready" | "unbound";

export interface ControlPlaneIssue {
  key: string;
  message: string;
}

export interface ControlPlaneSnapshot {
  activeContext: ActiveContextDocument | undefined;
  binding:
    | {
        sourceBindingId: string;
        workspace: {
          handle: string;
          id: string;
        };
      }
    | undefined;
  claims: readonly ControlPlaneClaim[];
  generatedAt: string;
  issues: readonly ControlPlaneIssue[];
  projectRoot: string;
  runtime: {
    database: "configured" | "missing";
    environment: SagaEnvironment;
    serviceUrl: string;
  };
  status: ControlPlaneStatus;
}

export interface ControlPlaneClaim {
  confidence: number;
  key: string;
  state: string;
  text: string;
}

interface WorkspaceBindingFile {
  schemaVersion: 1;
  sourceBinding: {
    id: string;
  };
  workspace: {
    handle: string;
    id: string;
  };
}

export async function readControlPlaneSnapshot(input: { cwd?: string } = {}) {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const generatedAt = new Date().toISOString();
  const runtimeExit = await Effect.runPromiseExit(loadRuntimeConfig({ cwd: projectRoot }));
  const config =
    Exit.isSuccess(runtimeExit) === true
      ? runtimeExit.value
      : {
          databaseUrl: undefined,
          environment: "development" as const,
          service: { host: "127.0.0.1", port: 4766 },
        };
  const runtime = {
    database: config.databaseUrl === undefined ? ("missing" as const) : ("configured" as const),
    environment: config.environment,
    serviceUrl: `http://${config.service.host}:${config.service.port.toString()}`,
  };
  const configIssues =
    Exit.isFailure(runtimeExit) === true
      ? runtimeExit.cause
          .toString()
          .split("\n")
          .map((message) => ({ key: "runtime", message }))
      : [];
  const bindingResult = readBindingFile(projectRoot);

  if (bindingResult.issue !== undefined) {
    return {
      activeContext: undefined,
      binding: undefined,
      claims: [],
      generatedAt,
      issues: [...configIssues, bindingResult.issue],
      projectRoot,
      runtime,
      status: "unbound" as const,
    } satisfies ControlPlaneSnapshot;
  }

  const binding = bindingResult.binding;
  if (config.databaseUrl === undefined) {
    return {
      activeContext: undefined,
      binding: bindingSummary(binding),
      claims: [],
      generatedAt,
      issues: [
        ...configIssues,
        { key: "DATABASE_URL", message: "Set DATABASE_URL before reading workspace memory." },
      ],
      projectRoot,
      runtime,
      status: "offline" as const,
    } satisfies ControlPlaneSnapshot;
  }

  const serviceExit = await Effect.runPromiseExit(makeDatabase(config, { postgres: { max: 1 } }));
  if (Exit.isFailure(serviceExit)) {
    return {
      activeContext: undefined,
      binding: bindingSummary(binding),
      claims: [],
      generatedAt,
      issues: [{ key: "database", message: serviceExit.cause.toString() }],
      projectRoot,
      runtime,
      status: "offline" as const,
    } satisfies ControlPlaneSnapshot;
  }

  const service = serviceExit.value;
  try {
    const [profile] = await service.db
      .select()
      .from(workspaceProfiles)
      .where(eq(workspaceProfiles.workspaceId, binding.workspace.id))
      .limit(1);
    const claims = await Effect.runPromise(
      listCurrentClaims(service, { limit: 8, workspaceId: binding.workspace.id }),
    );
    const recentEvents = await Effect.runPromise(
      listRecentRawEvents(service, { limit: 5, workspaceId: binding.workspace.id }),
    );
    const activeContext = compileActiveContext({
      claims,
      generatedAt,
      recentEvents,
      workspace: {
        handle: binding.workspace.handle,
        id: binding.workspace.id,
        profile: {
          summary: profile?.summary,
        },
      },
    });

    return {
      activeContext,
      binding: bindingSummary(binding),
      claims: claims.map(toControlPlaneClaim),
      generatedAt,
      issues: [],
      projectRoot,
      runtime,
      status: "ready" as const,
    } satisfies ControlPlaneSnapshot;
  } catch (cause) {
    return {
      activeContext: undefined,
      binding: bindingSummary(binding),
      claims: [],
      generatedAt,
      issues: [{ key: "database", message: errorMessage(cause) }],
      projectRoot,
      runtime,
      status: "offline" as const,
    } satisfies ControlPlaneSnapshot;
  } finally {
    await Effect.runPromise(service.close());
  }
}

function findProjectRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(cwd);
  }
}

function readBindingFile(
  projectRoot: string,
):
  | { binding: WorkspaceBindingFile; issue?: undefined }
  | { binding?: undefined; issue: ControlPlaneIssue } {
  const bindingPath = join(projectRoot, BINDING_FILE_NAME);
  if (!existsSync(bindingPath)) {
    return {
      issue: {
        key: BINDING_FILE_NAME,
        message: "No local workspace binding found. Run saga init from this repository.",
      },
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(bindingPath, "utf8")) as Partial<WorkspaceBindingFile>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.workspace?.id === undefined ||
      parsed.workspace.handle === undefined ||
      parsed.sourceBinding?.id === undefined
    ) {
      return {
        issue: {
          key: BINDING_FILE_NAME,
          message: "Local workspace binding is missing required workspace or source fields.",
        },
      };
    }

    return {
      binding: {
        schemaVersion: parsed.schemaVersion,
        sourceBinding: { id: parsed.sourceBinding.id },
        workspace: {
          handle: parsed.workspace.handle,
          id: parsed.workspace.id,
        },
      },
    };
  } catch (cause) {
    return {
      issue: {
        key: BINDING_FILE_NAME,
        message: `Could not read local workspace binding: ${errorMessage(cause)}`,
      },
    };
  }
}

function bindingSummary(binding: WorkspaceBindingFile): ControlPlaneSnapshot["binding"] {
  return {
    sourceBindingId: binding.sourceBinding.id,
    workspace: binding.workspace,
  };
}

function toControlPlaneClaim(claim: CurrentClaim): ControlPlaneClaim {
  return {
    confidence: claim.confidence,
    key: claim.claimKey,
    state: claim.state,
    text: claim.claimText,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
