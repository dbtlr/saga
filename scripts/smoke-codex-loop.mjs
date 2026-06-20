#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliBin = join(repoRoot, "apps/cli/bin/saga.js");
const requireFromCli = createRequire(new URL("../apps/cli/package.json", import.meta.url));
const postgresModule = await import(pathToFileURL(requireFromCli.resolve("postgres")).href);
const postgres = postgresModule.default;

const adminDatabaseUrl = process.env.SAGA_TEST_DATABASE_URL?.trim();
if (adminDatabaseUrl === undefined || adminDatabaseUrl === "") {
  console.error("missing required environment variable: SAGA_TEST_DATABASE_URL");
  process.exit(1);
}

const databaseName = `saga_codex_smoke_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const adminSql = postgres(adminDatabaseUrl, { max: 1 });
let workspacePath;
let failed = true;

try {
  await adminSql.unsafe(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;

  workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "saga-codex-loop-smoke-")));
  seedGitWorkspace(workspacePath);

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl.toString(),
  };

  run("pnpm", ["--filter", "@saga/service", "migrate"], { cwd: repoRoot, env });
  run(process.execPath, [cliBin, "--ascii", "init", "Codex Loop Smoke"], {
    cwd: workspacePath,
    env,
  });
  run(process.execPath, [cliBin, "--ascii", "harness", "install", "codex"], {
    cwd: workspacePath,
    env,
  });

  const status = JSON.parse(
    run(process.execPath, [cliBin, "--format", "json", "--ascii", "harness", "status", "codex"], {
      cwd: workspacePath,
      env,
    }),
  );
  assertCodexHarnessStatus(status);

  const hookResult = run(join(workspacePath, ".codex", "saga-codex-hook.sh"), [], {
    cwd: workspacePath,
    env,
    input: JSON.stringify(codexHookPayload(workspacePath)),
  });
  assertHookResult(hookResult);

  const recent = JSON.parse(
    run(process.execPath, [cliBin, "--format", "json", "--ascii", "ingest", "recent"], {
      cwd: workspacePath,
      env,
    }),
  );
  assertRecentEvents(recent);

  const context = JSON.parse(
    run(process.execPath, [cliBin, "--format", "json", "--ascii", "context"], {
      cwd: workspacePath,
      env,
    }),
  );
  assertActiveContext(context);

  console.log(`codex hook capture smoke passed: ${context.workspace.handle}`);
  console.log(`raw events: ${recent.length.toString()}`);
  console.log(`current claims: ${currentClaimLines(context).length.toString()}`);
  failed = false;
} finally {
  await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
  await adminSql.end({ timeout: 5 });

  if (workspacePath !== undefined && failed === false && process.env.SAGA_SMOKE_KEEP !== "1") {
    rmSync(workspacePath, { force: true, recursive: true });
  } else if (workspacePath !== undefined && failed === true) {
    console.error(`smoke workspace kept for inspection: ${workspacePath}`);
  }
}

function seedGitWorkspace(projectRoot) {
  const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  writeFileSync(
    join(projectRoot, "package.json"),
    `${JSON.stringify(
      {
        engines: rootPackageJson.engines,
        name: "saga-codex-loop-smoke",
        private: true,
        version: "0.0.0",
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@example.com:saga/codex-loop-smoke.git"], {
    cwd: projectRoot,
    stdio: "ignore",
  });
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src/index.ts"), "export const codexLoopSmoke = true;\n");
}

function codexHookPayload(projectRoot) {
  return {
    cwd: projectRoot,
    hook_event_name: "UserPromptSubmit",
    model: "gpt-5",
    permission_mode: "workspace-write",
    prompt: "We should dogfood Saga capture before broad rollout.",
    session_id: "codex-loop-smoke-session",
    transcript_path: join(projectRoot, ".codex", "smoke-transcript.jsonl"),
    turn_id: "codex-loop-smoke-turn-1",
  };
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with exit code ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter((part) => part.trim() !== "")
        .join("\n"),
    );
  }

  return result.stdout;
}

function assertCodexHarnessStatus(value) {
  if (value?.target !== "codex" || value?.state !== "configured") {
    throw new Error(`Codex harness was not configured: ${JSON.stringify(value, null, 2)}`);
  }

  if (value?.hooksCoverage !== "complete" || value?.hooks !== "installed") {
    throw new Error(`Codex hooks were not complete: ${JSON.stringify(value, null, 2)}`);
  }
}

function assertHookResult(stdout) {
  const parsed = JSON.parse(stdout);
  if (parsed?.continue !== true) {
    throw new Error(`Codex hook did not return a continuation response: ${stdout}`);
  }
  if (parsed.systemMessage !== undefined) {
    throw new Error(`Codex hook reported skipped capture: ${stdout}`);
  }
}

function assertRecentEvents(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`recent raw events were empty: ${JSON.stringify(value)}`);
  }

  const event = value.find((entry) => entry?.eventType === "codex.UserPromptSubmit");
  if (event === undefined) {
    throw new Error(`Codex prompt event was not captured: ${JSON.stringify(value, null, 2)}`);
  }

  if (event.payload?.prompt !== "We should dogfood Saga capture before broad rollout.") {
    throw new Error(`Codex prompt payload was not preserved: ${JSON.stringify(event, null, 2)}`);
  }
}

function assertActiveContext(value) {
  const currentClaims = currentClaimLines(value);
  if (currentClaims.length !== 0) {
    throw new Error(`Hook capture projected per-turn claims: ${JSON.stringify(value, null, 2)}`);
  }

  const recentActivity = sectionLines(value, "Recent Activity");
  if (!recentActivity.some((line) => line.includes("codex.UserPromptSubmit"))) {
    throw new Error(
      `Active Context did not include recent Codex activity: ${JSON.stringify(value)}`,
    );
  }
}

function currentClaimLines(value) {
  return sectionLines(value, "Current Claims").filter(
    (line) => line !== "No current claims projected yet.",
  );
}

function sectionLines(value, title) {
  const section = value?.sections?.find((entry) => entry?.title === title);
  return Array.isArray(section?.lines) ? section.lines : [];
}
