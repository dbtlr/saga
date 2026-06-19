import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  cliServiceCommand,
  controlPlaneCommand,
  renderStartReport,
  runStartCommand,
} from "./start.js";

const renderOptions = {
  ascii: true,
  color: "never" as const,
  format: "records" as const,
  isTty: false,
};

describe("renderStartReport", () => {
  test("renders service and control-plane endpoints", () => {
    expect(
      renderStartReport(
        {
          controlPlaneUrl: "http://127.0.0.1:4767",
          healthUrl: "http://127.0.0.1:4766/health",
          service: "started",
        },
        renderOptions,
      ),
    ).toContain("control  http://127.0.0.1:4767");
  });
});

describe("runStartCommand", () => {
  test("launches the control-plane dev server when the service is already running", async () => {
    const output: string[] = [];
    const exitCode = await runStartCommand([], renderOptions, (text) => output.push(text), {
      checkHealth: async () => "ok (http://127.0.0.1:4766/health)",
      cwd: process.cwd(),
      env: {},
      spawnControlPlane: async (input) => {
        expect(input.cwd).toBeTypeOf("string");
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(output[0]).toContain("service  already running");
  });

  test("starts an embedded service when health is unreachable", async () => {
    const output: string[] = [];
    const serviceChild = new FakeChildProcess();
    let healthChecks = 0;

    await expect(
      runStartCommand([], renderOptions, (text) => output.push(text), {
        checkHealth: async () => {
          healthChecks += 1;
          return healthChecks === 1 ? "unreachable" : "ok (http://127.0.0.1:4766/health)";
        },
        cwd: process.cwd(),
        env: {},
        spawnControlPlane: async () => 0,
        spawnService: () => serviceChild as unknown as ChildProcess,
      }),
    ).resolves.toBe(0);

    expect(output[0]).toContain("service  started");
    expect(serviceChild.signals).toContain("SIGTERM");
  });
});

describe("process command builders", () => {
  test("builds the control-plane dev command through pnpm", () => {
    expect(controlPlaneCommand({})).toEqual({
      args: ["--filter", "@saga/control-plane", "dev"],
      command: "pnpm",
    });
  });

  test("builds the service command as a CLI process", () => {
    const command = cliServiceCommand();

    expect(command.command).toBe(process.execPath);
    expect(command.args.at(-2)).toBe("service");
    expect(command.args.at(-1)).toBe("run");
  });
});

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    const normalizedSignal = typeof signal === "string" ? signal : "SIGTERM";
    this.killed = true;
    this.signalCode = normalizedSignal;
    this.signals.push(normalizedSignal);
    this.emit("exit", null, normalizedSignal);
    return true;
  }
}
