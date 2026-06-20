import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createLaunchdSupervisor,
  renderLaunchdPlist,
  renderServiceLifecycle,
  renderServiceStatus,
  runServiceCommand,
  serviceStatus,
  type ServiceLifecycleReport,
  type ServiceSupervisor,
} from "./service.js";

const renderOptions = {
  ascii: true,
  color: "never" as const,
  format: "records" as const,
  isTty: false,
};
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("serviceStatus", () => {
  test("reports unreachable service", async () => {
    const output = await serviceStatus(renderOptions);

    expect(output).toContain("Saga service status");
    expect(output).toContain("health");
  });
});

describe("renderServiceStatus", () => {
  test("reports observed running state", () => {
    expect(
      renderServiceStatus(
        {
          config: "127.0.0.1:4766",
          health: "ok (http://127.0.0.1:4766/health)",
          healthUrl: "http://127.0.0.1:4766/health",
          logs: "stdout/stderr",
          process: "running",
          supervisor: "running",
          supervisorDetail: "launchd agent is loaded",
        },
        renderOptions,
      ),
    ).toContain("process     running");
  });
});

describe("runServiceCommand", () => {
  test("dispatches lifecycle subcommands through the supervisor", async () => {
    const supervisor = fakeSupervisor();

    const output = await runServiceCommand(["restart"], renderOptions, { supervisor });

    expect(output).toContain("Saga service restart");
    expect(output).toContain("state   running");
  });

  test("includes supervisor state in status output", async () => {
    const output = await runServiceCommand(["status"], renderOptions, {
      supervisor: fakeSupervisor("stopped"),
    });

    expect(output).toContain("supervisor  stopped");
    expect(output).toContain("detail      fake supervisor stopped");
  });
});

describe("renderServiceLifecycle", () => {
  test("renders launchd lifecycle details", () => {
    expect(
      renderServiceLifecycle(
        {
          action: "install",
          detail: "installed and bootstrapped launchd agent",
          label: "com.saga.service",
          plistPath: "/Users/drew/Library/LaunchAgents/com.saga.service.plist",
          state: "installed",
        },
        renderOptions,
      ),
    ).toContain("plist   /Users/drew/Library/LaunchAgents/com.saga.service.plist");
  });
});

describe("renderLaunchdPlist", () => {
  test("builds a launchd agent for saga service run", () => {
    const plist = renderLaunchdPlist({
      paths: {
        plistPath: "/Users/drew/Library/LaunchAgents/com.saga.service.plist",
        stderrPath: "/Users/drew/Library/Logs/saga/service.err.log",
        stdoutPath: "/Users/drew/Library/Logs/saga/service.out.log",
      },
      projectRoot: "/Volumes/data/workspaces/saga",
    });

    expect(plist).toContain("<string>com.saga.service</string>");
    expect(plist).toContain("/Volumes/data/workspaces/saga/apps/cli/bin/saga.js");
    expect(plist).toContain("<string>service</string>");
    expect(plist).toContain("<string>run</string>");
  });

  test("uses the checked-in CLI bin wrapper", () => {
    expect(existsSync(join(workspaceRoot, "apps", "cli", "bin", "saga.js"))).toBe(true);
  });
});

describe("createLaunchdSupervisor", () => {
  test("does not mutate launchd state on non-macOS", async () => {
    if (process.platform === "darwin") return;
    const report = await createLaunchdSupervisor({ cwd: process.cwd() }).install();

    expect(report).toMatchObject({
      action: "install",
      detail: "launchd is only available on macOS",
      state: "unavailable",
    });
  });
});

function fakeSupervisor(state: "running" | "stopped" = "running"): ServiceSupervisor {
  const report = (action: ServiceLifecycleReport["action"]): ServiceLifecycleReport => ({
    action,
    detail: `fake supervisor ${action}`,
    label: "com.saga.service",
    plistPath: "/tmp/com.saga.service.plist",
    state: action === "uninstall" ? "not installed" : state,
  });
  return {
    inspect: async () => ({ detail: `fake supervisor ${state}`, state }),
    install: async () => report("install"),
    restart: async () => report("restart"),
    start: async () => report("start"),
    stop: async () => report("stop"),
    uninstall: async () => report("uninstall"),
  };
}
