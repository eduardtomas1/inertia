import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ElectronApplication, Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ElectronFixtureCloseError, observeElectronPage } from "../e2e/support/electron-app-lifecycle";
import { attachElectronFixtureCloseFailure } from "../e2e/support/electron-failure-evidence";
import { electronProcessEvidence, observeElectronIdentity } from "../e2e/support/electron-process-evidence";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null as number | null, signalCode: null,
    spawnargs: ["private argv"], privateEndpoint: "secret endpoint",
  }) as unknown as ChildProcess;
  return { child, evidence: electronProcessEvidence(child) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bounded Electron process lifecycle evidence", () => {
  it("records launcher and actual main identities separately through the owned bridge", async () => {
    const f = fixture();
    const evaluate = vi.fn(async () => 434343);
    observeElectronIdentity({ evaluate } as unknown as ElectronApplication, f.child);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5);
    Object.assign(f.child, { exitCode: 0 }); f.child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(30);
    f.child.emit("close", 0, null);
    const snapshot = f.evidence.snapshot();
    expect(snapshot).toEqual({ launcherPid: 424242, mainPid: 434343, mainIdentity: "captured",
      launcherExitObserved: true, launcherCloseObserved: true, launcherExitCode: 0,
      stages: [{ stage: "launcher-exit", elapsedMs: 5 }, { stage: "launcher-close", elapsedMs: 35 }],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|secret/u);
    expect(evaluate).toHaveBeenCalledOnce();
    f.evidence.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards late main identity after the one-second diagnostic bound", async () => {
    const f = fixture();
    let resolve!: (pid: number) => void;
    f.evidence.captureMainPid(() => new Promise<number>((finish) => { resolve = finish; }));
    await vi.advanceTimersByTimeAsync(1_000);
    resolve(434343);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.evidence.snapshot()).toMatchObject({ mainPid: null, mainIdentity: "timed-out" });
    expect(vi.getTimerCount()).toBe(0);
    f.evidence.stop();
  });

  it("distinguishes owned main-window page closure from launcher exit and close", async () => {
    const f = fixture();
    const page = new EventEmitter();
    observeElectronPage(page as unknown as Page, [], f.child);
    await vi.advanceTimersByTimeAsync(10);
    page.emit("close");
    expect(f.evidence.snapshot()).toMatchObject({
      launcherExitObserved: false, launcherCloseObserved: false,
      stages: [{ stage: "main-window-page-closed", elapsedMs: 10 }],
    });
    f.evidence.stop();
  });

  it.each([null, -1, "private PID", Number.NaN])("omits invalid main identity %s", async (pid) => {
    const f = fixture(); f.evidence.captureMainPid(async () => pid);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.evidence.snapshot()).toMatchObject({ mainPid: null, mainIdentity: "unavailable" });
    f.evidence.stop();
  });

  it("bounds records and stops observers and pending identity on fixture cleanup", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.evidence.captureMainPid(() => new Promise((_resolve, fail) => { reject = fail; }));
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 100; index++) f.evidence.record("quit-requested");
    f.evidence.stop();
    reject(new Error("secret bridge error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.evidence.snapshot().stages).toHaveLength(24);
    expect(f.child.listenerCount("exit")).toBe(0);
    expect(f.child.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(f.evidence.snapshot())).not.toContain("secret");
  });

  it("attaches scalar evidence only on failure", async () => {
    const f = fixture();
    const attach = vi.fn(async () => undefined);
    await attachElectronFixtureCloseFailure(() => ({ attach }), undefined);
    expect(attach).not.toHaveBeenCalled();
    const error = new ElectronFixtureCloseError([new Error("Original failure")], [], f.evidence.snapshot());
    await attachElectronFixtureCloseFailure(() => ({ attach }), error);
    expect(attach).toHaveBeenCalledExactlyOnceWith("electron-process-lifecycle", {
      contentType: "application/json", body: Buffer.from(JSON.stringify(error.processEvidence, null, 2)),
    });
    f.evidence.stop();
  });

  it("retains only complete fixed quit lines, bounds partial input and removes the observer", () => {
    const f = fixture();
    const stderr = new PassThrough();
    Object.assign(f.child, { stderr });
    f.evidence.record("quit-requested");
    stderr.write("private prefix Waiting for the debugger to disconnect...\n");
    stderr.write("[Inertia test exit: private-data]\n");
    stderr.write("private".repeat(1_000));
    stderr.write("[Inertia test exit: process-exit-called]\n");
    stderr.write("[Inertia test exit: window-destroy-");
    stderr.write("entered]\r\n[Inertia test exit: window-destroy-returned]\n");
    stderr.write("[Inertia test exit: process-exit-called]\nWaiting for the debugger to disconnect...\n");
    stderr.write("Waiting for the debugger to disconnect...\n");
    expect(f.evidence.snapshot().stages.map(({ stage }) => stage)).toEqual([
      "quit-requested", "window-destroy-entered", "window-destroy-returned",
      "process-exit-called", "debugger-disconnect-wait",
    ]);
    expect(JSON.stringify(f.evidence.snapshot())).not.toContain("private");
    f.evidence.stop();
    expect(stderr.listenerCount("data")).toBe(0);
    stderr.destroy();
  });

  it.each(["present", "ESRCH", "EPERM"])("records main PID presence as advisory only (%s)", async (result) => {
    const f = fixture();
    f.evidence.captureMainPid(async () => 434343);
    await vi.advanceTimersByTimeAsync(0);
    const probe = vi.fn(() => {
      if (result !== "present") throw Object.assign(new Error("private error"), { code: result });
    });
    f.evidence.observeMainPresence(probe);
    expect(probe).toHaveBeenCalledExactlyOnceWith(434343);
    expect(f.evidence.snapshot()).toMatchObject({
      launcherExitObserved: false, launcherCloseObserved: false,
      stages: [{ stage: `main-pid-advisory-${result === "present" ? "present" : result === "ESRCH" ? "absent" : "unknown"}`, elapsedMs: 0 }],
    });
    expect(JSON.stringify(f.evidence.snapshot())).not.toContain("private");
    f.evidence.stop();
  });

  it("shares the existing 250 ms reporting budget across scalar and sample evidence", async () => {
    const f = fixture();
    const attach = vi.fn(() => new Promise<void>(() => undefined));
    const error = new ElectronFixtureCloseError([], [{ pid: 434343, reason: "quit",
      status: "captured", output: "", truncated: false }], f.evidence.snapshot());
    const reporting = attachElectronFixtureCloseFailure(() => ({ attach }), error);
    await vi.advanceTimersByTimeAsync(250);
    await reporting;
    expect(attach).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.evidence.stop();
  });
});
