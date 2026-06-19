import { startSagaService } from "@saga/service";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { recordBlock, type RenderOptions } from "./render.js";

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

  return `service ${subcommand ?? ""} is not implemented yet`.trim();
}

export async function runService(options: RenderOptions): Promise<string> {
  const config = await Effect.runPromise(loadRuntimeConfig());
  const service = await startSagaService(config);
  process.once("SIGINT", () => void service.close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void service.close().then(() => process.exit(0)));

  const message = recordBlock(
    "Saga service",
    [
      { label: "health", value: `${service.url}/health` },
      { label: "mode", value: "foreground" },
    ],
    options,
  );

  return message;
}

export async function serviceStatus(options: RenderOptions): Promise<string> {
  const config = await Effect.runPromise(loadRuntimeConfig());
  const healthUrl = `http://${config.service.host}:${config.service.port}/health`;
  const health = await checkHealth(healthUrl);

  return recordBlock(
    "Saga service status",
    [
      { label: "process", value: "foreground or external supervisor" },
      { label: "config", value: `${config.service.host}:${config.service.port}` },
      { label: "logs", value: "stdout/stderr" },
      { label: "health", value: health },
    ],
    options,
  );
}

async function checkHealth(url: string): Promise<string> {
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
