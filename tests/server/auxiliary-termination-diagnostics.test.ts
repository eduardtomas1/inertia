import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withCodexControlClient } from "../../src/server/codex/control-client";
import { detectProvider, ProviderManager } from "../../src/server/providers";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import {
  posixCleanupDiagnosticFor,
  ProcessTreeTerminationError,
  requireProcessTreeTermination,
  terminateProcessTreeAndWait,
  type ProcessTreeTerminator,
} from "../../src/server/process-lifecycle";
import {
  describePosixCleanupDiagnostic,
  posixCleanupDiagnostic,
} from "../../src/server/posix-cleanup-diagnostics";
import {
  portableFixtureRoot,
  removePortableFixture,
  writeNodeFlagExecutable,
} from "../helpers/portable-provider-fixture";

type ProcessTable = (read: number) => { status: number | null; stdout: string; error?: NodeJS.ErrnoException };

const timedOutRead: ProcessTable = () => ({
  status: null,
  stdout: "",
  error: Object.assign(new Error("spawnSync /bin/ps ETIMEDOUT"), { code: "ETIMEDOUT" }),
});
const stoppedNeverObserved: ProcessTable = () => ({ status: 0, stdout: "4242 1 Ss\n" });
const runningThenGone: ProcessTable = (read) => ({
  status: 0,
  stdout: read === 1 ? "4242 1 Ss\n" : "1 0 Ss\n",
});
const failedRead: ProcessTable = () => ({ status: 1, stdout: "" });
const runningThenTimedOut: ProcessTable = (read) => read === 1 ? stoppedNeverObserved(read) : timedOutRead(read);

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(child, {
    pid: 4_242,
    exitCode: null,
    signalCode: null,
    stdio: [null, null, null],
    kill: vi.fn(() => true),
  });
  return child as unknown as ChildProcess;
}

function classifyingTermination(table: ProcessTable): ProcessTreeTerminator {
  return async (child, force) => {
    let reads = 0;
    return await terminateProcessTreeAndWait(child, force, {
      platform: "linux",
      killProcess: vi.fn(() => true) as never,
      spawnProcessSync: vi.fn(() => table(++reads)) as never,
      pauseSync: () => undefined,
      processCanExecute: () => null,
      processGroupCanExecute: () => null,
      waitMs: 20,
    });
  };
}

describe("POSIX cleanup rows", () => {
  it.each([
    { name: "every ps read timed out", table: timedOutRead,
      expected: { row: "ps-read-timed-out", rootState: "unknown", snapshotReads: 8, snapshotTimeouts: 8 } },
    { name: "the stop was never observed", table: stoppedNeverObserved,
      expected: { row: "stop-never-observed", rootState: "running", snapshotReads: 9, snapshotTimeouts: 0 } },
    { name: "the root ran and then disappeared", table: runningThenGone,
      expected: { row: "running-then-gone", rootState: "absent", snapshotReads: 2, snapshotTimeouts: 0 } },
    { name: "the root ran and every later ps read timed out", table: runningThenTimedOut,
      expected: { row: "ps-read-timed-out", rootState: "running", snapshotReads: 9, snapshotTimeouts: 8 } },
    { name: "every ps read failed without a timeout", table: failedRead,
      expected: { row: "unknown-root-state", rootState: "unknown", snapshotReads: 8, snapshotTimeouts: 0 } },
  ])("records $name on the terminated child", async ({ table, expected }) => {
    const child = fakeChild();
    await expect(requireProcessTreeTermination(
      classifyingTermination(table),
      child,
      true,
      "Provider discovery process tree",
    )).rejects.toMatchObject({
      message: "Provider discovery process tree could not be confirmed stopped.",
      posixCleanupDiagnostic: {
        scope: "child",
        reason: "exit-unconfirmed",
        rootStop: "sent",
        ...expected,
        elapsedMs: expect.any(Number),
      },
    });
    expect(posixCleanupDiagnosticFor(child)).toMatchObject(expected);
  });

  it("describes a classification with its reads and elapsed time", () => {
    expect(describePosixCleanupDiagnostic(posixCleanupDiagnostic({
      scope: "child",
      reason: "exit-unconfirmed",
      rootStop: "sent",
      rootState: "zombie",
      rootRunningObserved: true,
      scanStabilized: true,
      groupExited: true,
      descendantsExited: true,
      rootExited: true,
    }, { snapshotReads: 3, snapshotTimeouts: 0 }, 41.7))).toBe(
      "[POSIX cleanup running-then-gone: reason=exit-unconfirmed rootStop=sent rootState=zombie"
      + " rootRunningObserved=true scanStabilized=true groupExited=true descendantsExited=true"
      + " rootExited=true reads=3 timedOutReads=0 elapsedMs=41]",
    );
  });
});

function controlChild(onInput: (text: string, stdout: PassThrough) => void): ChildProcessWithoutNullStreams {
  const child = fakeChild() as unknown as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        onInput(String(chunk), stdout);
        callback();
      },
    }),
  });
  return child;
}

describe("Codex control client cleanup classification", () => {
  const controlOptions = (child: ChildProcessWithoutNullStreams) => ({
    executable: "/fake/codex",
    environment: {},
    cwd: "/workspace",
    timeoutMs: 30_000,
    spawnProcess: (() => child) as unknown as typeof spawn,
    terminateProcessTree: classifyingTermination(stoppedNeverObserved),
  });

  it("attaches the classification when a completed operation cannot confirm cleanup", async () => {
    const child = controlChild((text, stdout) => {
      const message = JSON.parse(text) as { id?: number };
      if (message.id !== undefined) stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    });
    await expect(withCodexControlClient(controlOptions(child), async () => "completed"))
      .rejects.toMatchObject({
        code: "process-tree-termination-unconfirmed",
        posixCleanupDiagnostic: { row: "stop-never-observed", snapshotReads: 9 },
      });
  });

  it("attaches the classification when the operation also failed", async () => {
    const child = controlChild((_text, stdout) => stdout.end());
    await expect(withCodexControlClient(controlOptions(child), async () => "unreachable"))
      .rejects.toMatchObject({
        code: "process-tree-termination-unconfirmed",
        message: expect.stringContaining("output closed early"),
        posixCleanupDiagnostic: { row: "stop-never-observed", snapshotReads: 9 },
      });
  });
});

describe("provider metadata and shutdown cleanup classification", () => {
  it("names the metadata classification in the shutdown error", async () => {
    const diagnostic = posixCleanupDiagnostic({
      scope: "child",
      reason: "exit-unconfirmed",
      rootStop: "sent",
      rootState: "unknown",
      rootRunningObserved: false,
      scanStabilized: false,
      groupExited: true,
      descendantsExited: true,
      rootExited: true,
    }, { snapshotReads: 8, snapshotTimeouts: 8 }, 2_004);
    const cache = new ProviderMetadataCache({
      read: async () => {
        throw new ProcessTreeTerminationError("Codex control process tree", {
          posixCleanupDiagnostic: diagnostic,
        });
      },
    });
    const manager = ProviderManager.createForTests({ metadataCache: cache });

    await cache.metadata("codex", "/fake/codex", {}, "/workspace", { force: true });

    expect(cache.processCleanupDiagnostics()).toEqual(new Map([["codex", diagnostic]]));
    await expect(manager.disposeAll()).rejects.toThrow(
      "Provider process cleanup could not be confirmed. Unconfirmed: codex metadata "
      + "[POSIX cleanup ps-read-timed-out: reason=exit-unconfirmed rootStop=sent rootState=unknown"
      + " rootRunningObserved=false scanStabilized=false groupExited=true descendantsExited=true"
      + " rootExited=true reads=8 timedOutReads=8 elapsedMs=2004].",
    );
  });
});

describe.skipIf(process.platform === "win32")("provider discovery cleanup classification", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function hangingCodex(): string {
    const root = portableFixtureRoot("auxiliary termination diagnostics");
    roots.push(root);
    return writeNodeFlagExecutable(root, "codex", "setInterval(() => {}, 1_000);\n");
  }

  const timedOutScan: ProcessTreeTerminator = async (child, force) =>
    await terminateProcessTreeAndWait(child, force, {
      spawnProcessSync: vi.fn(timedOutRead) as never,
      waitMs: 500,
    });

  it("carries the classification on a timed-out probe whose cleanup is unconfirmed", async () => {
    const detection = await detectProvider("codex", {
      command: hangingCodex(),
      timeoutMs: 300,
    }, { terminateProcessTree: timedOutScan });

    expect(detection).toMatchObject({
      cleanupConfirmed: false,
      cleanupDiagnostic: { row: "ps-read-timed-out", snapshotTimeouts: 8 },
    });
  });

  it("carries the classification when a cancelled probe cannot confirm cleanup", async () => {
    const controller = new AbortController();
    const detection = detectProvider("codex", {
      command: hangingCodex(),
      timeoutMs: 30_000,
      signal: controller.signal,
    }, { terminateProcessTree: timedOutScan });
    setTimeout(() => controller.abort(), 300);

    await expect(detection).rejects.toMatchObject({
      code: "process-tree-termination-unconfirmed",
      posixCleanupDiagnostic: { row: "ps-read-timed-out", snapshotTimeouts: 8 },
    });
  });
});
