import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  linuxProcessGroupCanExecute,
  runBounded,
} from "../../scripts/bounded-process-tree.mjs";
import {
  confirmProviderProcessTermination,
  processIsTerminal,
  requireAcpInitializeHandshake,
  runAcpInitializeHandshake,
} from "../../scripts/provider-drift-process.mjs";
import { executableProcessExists } from "../helpers/executable-process";

interface ProcessStateInput {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}

type FakeProcessState = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid: number;
  kill(signal?: NodeJS.Signals): unknown;
};

interface AcpFixtureOptions {
  allowMissingAgentInfo?: boolean;
  allowSessionCapabilitiesResume?: boolean;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxOutputChars?: number;
  requireLoadSession?: boolean;
}

function processState({
  exitCode = null,
  signalCode = null,
}: ProcessStateInput = {}): FakeProcessState {
  return Object.assign(new EventEmitter(), {
    exitCode,
    signalCode,
    pid: 101,
    kill: vi.fn((_signal?: NodeJS.Signals) => true),
  });
}

function acpFixture(
  source: string,
  options: AcpFixtureOptions = {},
): Promise<void> {
  const {
    allowMissingAgentInfo,
    allowSessionCapabilitiesResume,
    requireLoadSession = false,
    ...dependencies
  } = options;
  return runAcpInitializeHandshake(
    process.execPath,
    ["--input-type=commonjs", "-e", source],
    { cwd: process.cwd(), environment: process.env },
    {
      ...(allowMissingAgentInfo === undefined ? {} : { allowMissingAgentInfo }),
      ...(allowSessionCapabilitiesResume === undefined
        ? {}
        : { allowSessionCapabilitiesResume }),
      expectedAgent: "Fixture Agent",
      requireLoadSession,
    },
    {
      timeoutMs: 1_000,
      cleanupTimeoutMs: 250,
      ...dependencies,
    },
  );
}

function validResponse(
  capabilities = "agentCapabilities: {},",
  agentInfo = 'agentInfo: { name: "Fixture Agent", version: "1.0.0" },',
): string {
  return `
    const readline = require("node:readline");
    readline.createInterface({ input: process.stdin }).once("line", (line) => {
      const message = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: 1,
        ${capabilities}
        ${agentInfo}
      } }) + "\\n");
    });
    setInterval(() => {}, 1_000);
  `;
}

describe("provider drift process cleanup", () => {
  it("recognizes a Linux process group containing only terminal states", () => {
    const processIds = () => ["100", "101", "900"];
    const states = new Map([
      ["100", "100 (root) Z 1 100 100"],
      ["101", "101 (child) X 1 100 100"],
      ["900", "900 (unrelated) S 1 900 900"],
    ]);
    const readStat = (pid: string) => states.get(pid)!;

    expect(linuxProcessGroupCanExecute(100, {
      processIds,
      readStat,
    })).toBe(false);
    states.set("101", "101 (child) S 1 100 100");
    expect(linuxProcessGroupCanExecute(100, {
      processIds,
      readStat,
    })).toBe(true);
    states.set("101", "malformed");
    expect(linuxProcessGroupCanExecute(100, {
      processIds,
      readStat,
    })).toBeNull();
  });

  it("enforces the output ceiling and proves ordinary tree cleanup", async () => {
    let childPid = 0;
    try {
      const script = [
        'process.stdout.write(`PID:${process.pid}\\n`);',
        'process.stdout.write("x".repeat(33));',
        "setInterval(() => {}, 1_000);",
      ].join("");
      let failure: unknown;
      try {
        await runBounded(process.execPath, ["-e", script], {
          env: process.env,
          label: "Provider output limit fixture",
          maxOutputBytes: 32,
          timeoutMs: 2_000,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message.split("\n")[0]).toBe(
        "Provider output limit fixture exceeded its output limit; its complete process tree was terminated.",
      );
      const reportedPid = /PID:(\d+)/u.exec((failure as Error).message)?.[1];
      expect(reportedPid).toBeDefined();
      childPid = Number.parseInt(reportedPid!, 10);
      expect(executableProcessExists(childPid)).toBe(false);
    } finally {
      if (childPid > 0 && executableProcessExists(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("does not execute a payload before gated ownership admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-provider-admission-"));
    const marker = join(root, "payload-started");
    try {
      await expect(runBounded(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`,
      ], {
        env: process.env,
        label: "Provider paused admission fixture",
        onSpawn: () => {
          throw new Error("Provider ownership was deliberately refused.");
        },
        timeoutMs: 2_000,
      })).rejects.toThrow("ownership was deliberately refused");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes immediate normal and signaled termination", async () => {
    const normal = processState({ exitCode: 0 });
    const signaled = processState({ signalCode: "SIGKILL" });
    expect(processIsTerminal(normal)).toBe(true);
    expect(processIsTerminal(signaled)).toBe(true);
    expect(processIsTerminal(processState())).toBe(false);
    await expect(confirmProviderProcessTermination(normal, 50)).resolves.toBe(true);
    await expect(confirmProviderProcessTermination(signaled, 50)).resolves.toBe(true);
    expect(normal.kill).not.toHaveBeenCalled();
    expect(signaled.kill).not.toHaveBeenCalled();
  });

  it("arms completion before terminating a process that exits synchronously", async () => {
    const child = processState();
    child.kill = vi.fn(() => {
      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
      return true;
    });
    await expect(confirmProviderProcessTermination(child, 50)).resolves.toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("reports unconfirmed exact-child cleanup", async () => {
    const child = processState();
    await expect(confirmProviderProcessTermination(child, 10)).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("uses the shared authority to reject and remove provider descendants", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-provider-nested-"));
    const marker = join(root, "descendant.pid");
    let descendantPid = 0;
    try {
      const script = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const descendant = spawn(process.execPath, ["-e", "process.send?.(\\"ready\\"); process.on(\\"disconnect\\", () => {}); setInterval(() => {}, 1000)"], { detached: process.platform === "win32", stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });',
        'const readline = require("node:readline");',
        "let message; let descendantReady = false; let responded = false;",
        "const respond = () => { if (responded || !message || !descendantReady) return; responded = true;",
        'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {',
        'protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "Fixture Agent", version: "1.0.0" }',
        '}}) + "\\n"); };',
        'readline.createInterface({ input: process.stdin }).once("line", (line) => { message = JSON.parse(line); respond(); });',
        'descendant.once("message", () => { if (process.platform === "win32") { descendant.disconnect(); descendant.unref(); } writeFileSync(process.argv[1], String(descendant.pid)); descendantReady = true; respond(); });',
        "setInterval(() => {}, 1_000);",
      ].join("");
      await expect(requireAcpInitializeHandshake(
        process.execPath,
        ["-e", script, marker],
        { cwd: root, environment: process.env },
        { expectedAgent: "Fixture Agent", requireLoadSession: false },
        { timeoutMs: 1_000, cleanupTimeoutMs: 500 },
      )).rejects.toThrow("left descendant processes running");
      descendantPid = Number.parseInt(readFileSync(marker, "utf8"), 10);
      expect(executableProcessExists(descendantPid)).toBe(false);
    } finally {
      if (descendantPid > 0 && executableProcessExists(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("provider drift ACP initialize", () => {
  it("accepts a bounded initialize response and exact identity", async () => {
    await expect(acpFixture(validResponse())).resolves.toBeUndefined();
  });

  it("can advertise the reduced Gemini client capability surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-provider-gemini-capabilities-"));
    try {
      const capture = join(root, "initialize.json");
      const source = `
        const fs = require("node:fs");
        const readline = require("node:readline");
        readline.createInterface({ input: process.stdin }).once("line", (line) => {
          const message = JSON.parse(line);
          fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(message));
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "gemini-cli", version: "0.58.0" },
          } }) + "\\n");
        });
        setInterval(() => {}, 1_000);
      `;
      await expect(runAcpInitializeHandshake(
        process.execPath,
        ["--input-type=commonjs", "-e", source],
        { cwd: root, environment: process.env },
        {
          expectedAgent: "gemini-cli",
          requireLoadSession: false,
          advertiseCompaction: false,
        },
      )).resolves.toBeUndefined();
      expect(JSON.parse(readFileSync(capture, "utf8"))).toMatchObject({
        params: { clientCapabilities: { plan: {} } },
      });
      expect(JSON.parse(readFileSync(capture, "utf8")).params.clientCapabilities)
        .not.toHaveProperty("session");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects early exit, timeout, malformed JSON, and oversized output", async () => {
    await expect(acpFixture("process.exit(0);"))
      .rejects.toThrow("exited during initialize");
    await expect(acpFixture("setInterval(() => {}, 1_000);", { timeoutMs: 20 }))
      .rejects.toThrow("initialize timed out");
    await expect(acpFixture(`
      process.stdout.write("not-json\\n");
      setInterval(() => {}, 1_000);
    `)).rejects.toThrow("malformed JSON");
    await expect(acpFixture(`
      process.stdout.write("x".repeat(33));
      setInterval(() => {}, 1_000);
    `, { maxOutputChars: 32 })).rejects.toThrow("output exceeded the limit");
  });

  it.each([
    {
      name: "invalid JSON-RPC version",
      response: '{ id: message.id, result: { protocolVersion: 1 } }',
    },
    {
      name: "result and error hybrid",
      response: '{ jsonrpc: "2.0", id: message.id, error: null, result: { protocolVersion: 1 } }',
    },
    {
      name: "method and result hybrid",
      response: '{ jsonrpc: "2.0", id: message.id, method: "session/update", result: { protocolVersion: 1 } }',
    },
    {
      name: "wrong request id",
      response: '{ jsonrpc: "2.0", id: 2, result: { protocolVersion: 1 } }',
    },
  ])("rejects $name", async ({ response }) => {
    await expect(acpFixture(`
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify(${response}) + "\\n");
      });
      setInterval(() => {}, 1_000);
    `)).rejects.toThrow("invalid JSON-RPC response");
  });

  it("rejects parsed JSON that is not a JSON-RPC message", async () => {
    await expect(acpFixture(`
      process.stdout.write("null\\n");
      setInterval(() => {}, 1_000);
    `)).rejects.toThrow("invalid JSON-RPC message");
  });

  it("requires Cursor loadSession and accepts either valid Kimi resume signal", async () => {
    await expect(acpFixture(validResponse(""), {
      allowSessionCapabilitiesResume: true,
      requireLoadSession: true,
    })).rejects.toThrow("does not advertise session resume support");
    await expect(acpFixture(
      validResponse("agentCapabilities: {},"),
      { requireLoadSession: true },
    )).rejects.toThrow("does not advertise session resume support");
    await expect(acpFixture(
      validResponse("agentCapabilities: { loadSession: true },"),
      { requireLoadSession: true },
    )).resolves.toBeUndefined();
    await expect(acpFixture(
      validResponse("agentCapabilities: { sessionCapabilities: { resume: {} } },"),
      {
        allowSessionCapabilitiesResume: true,
        requireLoadSession: true,
      },
    )).resolves.toBeUndefined();
    await expect(acpFixture(
      validResponse("agentCapabilities: { sessionCapabilities: { resume: [] } },"),
      {
        allowSessionCapabilitiesResume: true,
        requireLoadSession: true,
      },
    )).rejects.toThrow("does not advertise session resume support");
  });

  it("requires the exact selected provider identity", async () => {
    await expect(acpFixture(validResponse(
      "agentCapabilities: {},",
      'agentInfo: { name: "Other Agent", version: "1.0.0" },',
    ))).rejects.toThrow("initialize response is incompatible");
    await expect(acpFixture(`
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: 1, agentCapabilities: {},
        } }) + "\\n");
      });
      setInterval(() => {}, 1_000);
    `)).rejects.toThrow("initialize response is incompatible");
  });

  it.each(["", "agentInfo: null,"])("allows optional ACP metadata only when configured: %s", async (agentInfo) => {
    const source = validResponse("agentCapabilities: { loadSession: true },", agentInfo);
    await expect(acpFixture(source, { requireLoadSession: true }))
      .rejects.toThrow("initialize response is incompatible");
    await expect(acpFixture(source, {
      allowMissingAgentInfo: true, requireLoadSession: true,
    })).resolves.toBeUndefined();
    await expect(acpFixture(validResponse("agentCapabilities: {},", agentInfo), {
      allowMissingAgentInfo: true, requireLoadSession: true,
    })).rejects.toThrow("does not advertise session resume support");
  });

  it.each([
    '"Cursor"', '[]', '{}', '{ name: "Other Agent", version: "1" }',
    '{ name: "Fixture Agent" }', '{ name: "Fixture Agent", version: 1 }',
  ])("rejects incompatible present metadata even when omission is allowed: %s", async (agentInfo) => {
    await expect(acpFixture(validResponse(
      "agentCapabilities: { loadSession: true },", `agentInfo: ${agentInfo},`,
    ), { allowMissingAgentInfo: true, requireLoadSession: true }))
      .rejects.toThrow("initialize response is incompatible");
  });

  it("fails closed when exact-child cleanup is unconfirmed", async () => {
    type FakeAcpChild = FakeProcessState & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
    };
    const child = Object.assign(processState(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          const message = JSON.parse(chunk.toString("utf8"));
          child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "Fixture Agent", version: "1.0.0" },
          } })}\n`);
          callback();
        },
      }),
    }) as FakeAcpChild;
    await expect(runAcpInitializeHandshake(
      "fixture",
      ["acp"],
      { cwd: process.cwd(), environment: process.env },
      { expectedAgent: "Fixture Agent", requireLoadSession: false },
      { spawn: () => child, timeoutMs: 50, cleanupTimeoutMs: 10 },
    )).rejects.toThrow("cleanup could not be confirmed");
  });

  it("handles stdin EPIPE without an unhandled stream error", async () => {
    type FakeAcpChild = FakeProcessState & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
    };
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      pid: 102,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(_chunk, _encoding, callback) {
          const error = new Error("broken pipe") as NodeJS.ErrnoException;
          error.code = "EPIPE";
          callback(error);
        },
      }),
      kill: vi.fn(() => {
        child.signalCode = "SIGKILL";
        child.emit("close", null, "SIGKILL");
        return true;
      }),
    }) as FakeAcpChild;

    await expect(runAcpInitializeHandshake(
      "fixture",
      ["acp"],
      { cwd: process.cwd(), environment: process.env },
      { expectedAgent: "Fixture Agent", requireLoadSession: false },
      { spawn: () => child, timeoutMs: 50, cleanupTimeoutMs: 50 },
    )).rejects.toThrow("broken pipe");
  });
});
