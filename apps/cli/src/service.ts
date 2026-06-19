import { startSagaService } from "@saga/service";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { formatCommandOutput } from "./output.js";
import { recordBlock, type RenderOptions } from "./render.js";

export interface ServiceStatusReport {
  config: string;
  health: string;
  healthUrl: string;
  logs: string;
  process: "running" | "not running";
}

export async function runServiceCommand(
  args: readonly string[],
  options: RenderOptions,
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === "run") {
    return runService(options);
  }
  if (subcommand === "status") {
    return serviceStatus(options);
  }

  throw new Error(`service ${subcommand ?? ""} is not implemented yet`.trim());
}

export async function runService(options: RenderOptions): Promise<string> {
  const config = await Effect.runPromise(loadRuntimeConfig());
  const service = await startSagaService(config);
  process.once("SIGINT", () => void service.close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void service.close().then(() => process.exit(0)));

  return formatCommandOutput(
    {
      id: "service",
      records: recordBlock(
        "Saga service",
        [
          { label: "health", value: `${service.url}/health` },
          { label: "mode", value: "foreground" },
        ],
        options,
      ),
      value: {
        healthUrl: `${service.url}/health`,
        mode: "foreground",
      },
    },
    options.format,
  );
}

export async function serviceStatus(options: RenderOptions): Promise<string> {
  const report = await inspectServiceStatus();

  return formatCommandOutput(
    {
      id: "service",
      records: renderServiceStatus(report, options),
      value: report,
    },
    options.format,
  );
}

export async function inspectServiceStatus(): Promise<ServiceStatusReport> {
  const config = await Effect.runPromise(loadRuntimeConfig());
  const healthUrl = `http://${config.service.host}:${config.service.port}/health`;
  const health = await checkHealth(healthUrl);
  return {
    config: `${config.service.host}:${config.service.port}`,
    health,
    healthUrl,
    logs: "stdout/stderr",
    process: health.startsWith("ok ") ? "running" : "not running",
  };
}

export function renderServiceStatus(report: ServiceStatusReport, options: RenderOptions): string {
  return recordBlock(
    "Saga service status",
    [
      { label: "process", value: report.process },
      { label: "config", value: report.config },
      { label: "logs", value: report.logs },
      { label: "health", value: report.health },
    ],
    options,
  );
}

export async function checkHealth(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) return `unhealthy (${String(response.status)})`;
    const payload = (await response.json()) as { ok?: unknown };
    return payload.ok === true ? `ok (${url})` : `unexpected response (${url})`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unreachable (${message})`;
  }
}
