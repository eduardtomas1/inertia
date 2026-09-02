import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  confirmProviderProcessTermination,
  processIsTerminal,
  requireAcpInitializeHandshake,
} from "../../scripts/provider-drift-process.mjs";

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
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxOutputChars?: number;
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
  return requireAcpInitializeHandshake(
    process.execPath,
    ["--input-type=commonjs", "-e", source],
    { cwd: process.cwd(), environment: process.env },
    /fixture/iu,
    {
      timeoutMs: 250,
      cleanupTimeoutMs: 250,
      ...options,
    },
  );
}

describe("provider drift process cleanup", () => {
  it("recognizes immediate normal and signaled termination", async () => {
    const normal = processState({ exitCode: 0 });
    const signaled = processState({ signalCode: "SIGKILL" });
    const terminate = vi.fn();
    expect(processIsTerminal(normal)).toBe(true);
    expect(processIsTerminal(signaled)).toBe(true);
    expect(processIsTerminal(processState())).toBe(false);
    await expect(confirmProviderProcessTermination(normal, terminate, 50))
      .resolves.toBe(true);
    await expect(confirmProviderProcessTermination(signaled, terminate, 50))
      .resolves.toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("arms completion before terminating a process that exits synchronously", async () => {
    const child = processState();
    const terminate = vi.fn(() => {
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
    });

    await expect(confirmProviderProcessTermination(child, terminate, 50))
      .resolves.toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("reports cleanup timeout when no terminal state or event is observed", async () => {
    const child = processState();
    await expect(confirmProviderProcessTermination(child, vi.fn(), 10))
      .resolves.toBe(false);
  });
});

describe("provider drift ACP initialize", () => {
  it("accepts a bounded initialize response and confirms signaled cleanup", async () => {
    await expect(acpFixture(`
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).once("line", (line) => {
        const message = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: "Fixture Agent", version: "1.0.0" },
        } }) + "\\n");
      });
      setInterval(() => {}, 1_000);
    `)).resolves.toBeUndefined();
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
      kill: vi.fn((_signal?: NodeJS.Signals) => true),
    }) as FakeAcpChild;
    const terminate = (): void => {
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
    };

    await expect(requireAcpInitializeHandshake(
      "fixture",
      ["acp"],
      { cwd: process.cwd(), environment: process.env },
      /fixture/iu,
      {
        spawn: () => child,
        terminate,
        timeoutMs: 50,
        cleanupTimeoutMs: 50,
      },
    )).rejects.toThrow("broken pipe");
  });
});
