import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type RemoteEmbeddingPolicyState = "enabled" | "disabled";
// "default" covers the fail-closed cases: no config, missing key, or unreadable/malformed
// config. A future workspace override layer adds "workspace-config" without touching callers.
export type EmbeddingPolicySource = "installation-config" | "default";

export interface EmbeddingPolicyResolutionOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readFile?: (path: string) => string;
}

export interface EmbeddingPolicy {
  detail: string;
  remoteEmbeddings: RemoteEmbeddingPolicyState;
  source: EmbeddingPolicySource;
}

export interface InstallationConfigLocation {
  displayPath: string;
  path: string;
}

export function installationConfigLocation(
  options: EmbeddingPolicyResolutionOptions = {},
): InstallationConfigLocation {
  const env = options.env ?? process.env;
  const sagaHome = optionalString(env.SAGA_HOME);
  if (sagaHome !== undefined) {
    return {
      displayPath: "SAGA_HOME/config.json",
      path: resolve(sagaHome, "config.json"),
    };
  }

  const home = options.homeDir ?? homedir();
  return {
    displayPath: "~/.saga/config.json",
    path: resolve(home, ".saga", "config.json"),
  };
}

export function resolveEmbeddingPolicy(
  options: EmbeddingPolicyResolutionOptions = {},
): EmbeddingPolicy {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const location = installationConfigLocation(options);

  let rawConfig: string;
  try {
    rawConfig = readFile(location.path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return disabledByDefault(
        `no installation config at ${location.displayPath}; remote embeddings disabled by default`,
      );
    }
    return disabledByDefault(
      `could not read ${location.displayPath}: ${errorMessage(error)}; remote embeddings disabled`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch {
    return disabledByDefault(`could not parse ${location.displayPath}; remote embeddings disabled`);
  }

  const remote = readRemoteEmbeddingsState(parsed);
  if (remote === "enabled") {
    return {
      detail: `remote embeddings enabled by installation standard in ${location.displayPath}`,
      remoteEmbeddings: "enabled",
      source: "installation-config",
    };
  }
  if (remote === "disabled") {
    return {
      detail: `remote embeddings disabled by installation standard in ${location.displayPath}`,
      remoteEmbeddings: "disabled",
      source: "installation-config",
    };
  }

  return disabledByDefault(
    `${location.displayPath} does not set embeddings.remote; remote embeddings disabled by default`,
  );
}

function disabledByDefault(detail: string): EmbeddingPolicy {
  return {
    detail,
    remoteEmbeddings: "disabled",
    source: "default",
  };
}

function readRemoteEmbeddingsState(value: unknown): RemoteEmbeddingPolicyState | undefined {
  if (!isRecord(value)) return undefined;
  const embeddings = value.embeddings;
  if (!isRecord(embeddings)) return undefined;
  const remote = embeddings.remote;
  if (remote === "enabled" || remote === "disabled") return remote;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
