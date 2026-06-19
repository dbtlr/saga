import { spawn, type ChildProcess } from "node:child_process";
import { startSagaService, type SagaServiceHandle } from "@saga/service";
import { loadRuntimeConfig, type RuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { findProjectRoot } from "./init.js";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";
import { checkHealth } from "./service.js";

export interface SagaStartReport {
  controlPlaneUrl: string;
  healthUrl: string;
  service: "already running" | "started";
}

export interface StartDependencies {
  checkHealth?: (url: string) => Promise<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnControlPlane?: (input: SpawnControlPlaneInput) => Promise<number>;
  startService?: (config: RuntimeConfig) => Promise<SagaServiceHandle>;
}

export interface SpawnControlPlaneInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const CONTROL_PLANE_HOST = "127.0.0.1";
const CONTROL_PLANE_PORT = 4767;

export async function runStartCommand(
  args: readonly string[],
  options: RenderOptions,
  write: (text: string) => void,
  dependencies: StartDependencies = {},
): Promise<number> {
  if (args.length > 0) {
    throw new Error("start does not accept arguments yet");
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const projectRoot = findProjectRoot(cwd);
  const env = dependencies.env ?? process.env;
  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot, env }));
  const healthUrl = `http://${config.service.host}:${config.service.port.toString()}/health`;
  const observedHealth = await (dependencies.checkHealth ?? checkHealth)(healthUrl);
  const embeddedService = observedHealth.startsWith("ok ")
    ? undefined
    : await (dependencies.startService ?? startSagaService)(config);
  const report: SagaStartReport = {
    controlPlaneUrl: `http://${CONTROL_PLANE_HOST}:${CONTROL_PLANE_PORT.toString()}`,
    healthUrl,
    service: embeddedService === undefined ? "already running" : "started",
  };

  write(renderStartReport(report, options));

  try {
    return await (dependencies.spawnControlPlane ?? spawnControlPlaneDev)({
      cwd: projectRoot,
      env,
    });
  } finally {
    if (embeddedService !== undefined) {
      await embeddedService.close();
    }
  }
}

export function renderStartReport(report: SagaStartReport, options: RenderOptions): string {
  return formatCommandOutput(
    {
      id: "start",
      records: recordBlock(
        "Saga start",
        [
          { label: "service", value: report.service },
          { label: "health", value: report.healthUrl },
          { label: "control", value: report.controlPlaneUrl },
        ],
        options,
      ),
      value: report,
    },
    options.format,
  );
}

export function spawnControlPlaneDev(input: SpawnControlPlaneInput): Promise<number> {
  const command = pnpmCommand(input.env);
  const child = spawn(
    command.command,
    [...command.args, "--filter", "@saga/control-plane", "dev"],
    {
      cwd: input.cwd,
      env: input.env,
      stdio: "inherit",
    },
  );

  return waitForChild(child);
}

function pnpmCommand(env: NodeJS.ProcessEnv): { args: string[]; command: string } {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath === undefined || npmExecPath.trim() === "") {
    return { args: [], command: "pnpm" };
  }

  if (npmExecPath.endsWith(".cjs") || npmExecPath.endsWith(".js")) {
    return { args: [npmExecPath], command: process.execPath };
  }

  return { args: [], command: npmExecPath };
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        resolve(130);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
