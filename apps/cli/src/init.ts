import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  makeDatabase,
  registerWorkspace,
  runMigrations,
  type RegisterWorkspaceResult,
} from "@saga/db";
import { loadRuntimeConfig } from "@saga/runtime";
import { Effect } from "effect";
import { recordBlock, type RenderOptions } from "./render.js";

export const BINDING_FILE_NAME = ".saga.local.json";

export interface InitResult {
  bindingPath: string;
  projectRoot: string;
  registration: RegisterWorkspaceResult;
}

export interface WorkspaceBindingFile {
  project: {
    gitRemote: string | undefined;
    root: string;
  };
  schemaVersion: 1;
  service: {
    databaseUrl: "env:DATABASE_URL";
  };
  sourceBinding: {
    id: string;
  };
  workspace: {
    handle: string;
    id: string;
  };
}

export async function runInit(args: readonly string[], options: RenderOptions): Promise<string> {
  const result = await initProject({ handle: args[0] });
  return recordBlock(
    "Workspace bound",
    [
      { label: "workspace", value: result.registration.workspace.handle },
      { label: "workspace id", value: result.registration.workspace.id },
      { label: "source", value: result.registration.sourceBinding.sourceUri },
      { label: "binding", value: result.bindingPath },
    ],
    options,
  );
}

export async function initProject(input: {
  cwd?: string;
  handle?: string | undefined;
}): Promise<InitResult> {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const gitRemote = readGitRemote(projectRoot);
  const handle = normalizeHandle(input.handle ?? basename(projectRoot));
  const sourceUri = pathToFileURL(projectRoot).href;

  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot }));
  const service = await Effect.runPromise(makeDatabase(config));

  try {
    await Effect.runPromise(runMigrations(service));
    const registration = await Effect.runPromise(
      registerWorkspace(service, {
        displayName: basename(projectRoot),
        handle,
        source: {
          config: {
            gitRemote,
            path: projectRoot,
          },
          displayName: basename(projectRoot),
          type: "git",
          uri: sourceUri,
        },
      }),
    );
    const bindingPath = writeBindingFile(projectRoot, {
      project: {
        gitRemote,
        root: projectRoot,
      },
      schemaVersion: 1,
      service: {
        databaseUrl: "env:DATABASE_URL",
      },
      sourceBinding: {
        id: registration.sourceBinding.id,
      },
      workspace: {
        handle: registration.workspace.handle,
        id: registration.workspace.id,
      },
    });

    return {
      bindingPath,
      projectRoot,
      registration,
    };
  } finally {
    await Effect.runPromise(service.close());
  }
}

export function findProjectRoot(cwd: string): string {
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

export function readGitRemote(projectRoot: string): string | undefined {
  try {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return remote === "" ? undefined : remote;
  } catch {
    return undefined;
  }
}

export function normalizeHandle(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return normalized === "" ? "workspace" : normalized;
}

export function writeBindingFile(projectRoot: string, binding: WorkspaceBindingFile): string {
  mkdirSync(projectRoot, { recursive: true });
  const bindingPath = join(projectRoot, BINDING_FILE_NAME);
  writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
  return bindingPath;
}

export function bindingPathFor(projectRoot: string): string {
  return join(projectRoot, BINDING_FILE_NAME);
}

export function readBindingFile(projectRoot: string): WorkspaceBindingFile | undefined {
  const bindingPath = bindingPathFor(projectRoot);
  if (!existsSync(bindingPath)) return undefined;
  return JSON.parse(readFileSync(bindingPath, "utf8")) as WorkspaceBindingFile;
}
