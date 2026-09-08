import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeDiagnostics } from "../../src/main/runtime-diagnostics";
import {
  attachImageSendFailureDiagnostics, projectImageSendRuntimeSnapshot,
  readImageSendRuntimeRecords,
} from "../e2e/support/image-send-failure-diagnostics";

const directories: string[] = [];
async function fixture(): Promise<{ root: string; logs: string; diagnostics: RuntimeDiagnostics }> {
  const root = await mkdtemp(join(tmpdir(), "inertia-image-diagnostic-"));
  directories.push(root);
  const logs = join(root, "electron-profile", "logs", "runtime");
  const diagnostics = new RuntimeDiagnostics(logs);
  diagnostics.ensureDirectory();
  return { root, logs, diagnostics };
}
const signal = (): AbortSignal => new AbortController().signal;

describe("image-send failure evidence", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("projects fixed codes and scalars without arbitrary errors or authenticated endpoints", () => {
    expect(projectImageSendRuntimeSnapshot({
      phase: "stopped", generation: 2, pid: null, restartAttempt: 1, restartScheduled: false,
      lastError: "The runtime exited before complete process-tree cleanup was confirmed. PRIVATE",
      startupBlockerCode: "prior-runtime-cleanup-unconfirmed", websocketUrl: "ws://PRIVATE",
      unexpected: "PRIVATE",
    })).toEqual({ phase: "stopped", generation: 2, pid: null, restartAttempt: 1,
      restartScheduled: false, lastErrorCode: "exit-before-cleanup",
      startupBlockerCode: "prior-runtime-cleanup-unconfirmed" });
    const invalid = projectImageSendRuntimeSnapshot({ phase: "PRIVATE", generation: -1, pid: Infinity,
      restartAttempt: "PRIVATE", restartScheduled: "PRIVATE", lastError: "PRIVATE", startupBlockerCode: "PRIVATE" });
    expect(invalid).toEqual({ phase: null, generation: null, pid: null, restartAttempt: null,
      restartScheduled: null, lastErrorCode: "detail-omitted", startupBlockerCode: null });
  });

  it("reads authenticated lifecycle records without writing or retaining raw messages", async () => {
    const f = await fixture();
    f.diagnostics.record("runtime.failure", { phase: "stopped", generation: 1,
      message: "Conversation attachment storage shutdown could not be confirmed." });
    const path = join(f.logs, "runtime.log");
    const before = await readFile(path);
    const records = await readImageSendRuntimeRecords(f.root, signal());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "runtime.failure", phase: "stopped", generation: 1,
      lastErrorCode: "attachment-close-unconfirmed" });
    expect(JSON.stringify(records)).not.toContain("message");
    expect(await readFile(path)).toEqual(before);
  });

  it("projects a persisted startup cause and cleanup failure as bounded codes", async () => {
    const f = await fixture();
    const message = "Runtime initialization failed (git-timeout)."
      + " Runtime shutdown could not confirm cleanup after incomplete startup.";
    f.diagnostics.record("runtime.failure", { phase: "restarting", generation: 1, message });
    expect(await readImageSendRuntimeRecords(f.root, signal())).toEqual([
      expect.objectContaining({
        lastErrorCode: "startup-initialization-git-timeout+startup-cleanup-unconfirmed",
      }),
    ]);
    expect(projectImageSendRuntimeSnapshot({ lastError: `${message} PRIVATE` }))
      .toMatchObject({ lastErrorCode: "detail-omitted" });
    expect(projectImageSendRuntimeSnapshot({ lastError: message.replace("git-timeout", "PRIVATE") }))
      .toMatchObject({ lastErrorCode: "detail-omitted" });
  });

  it("ignores forged, extra-field, malformed, oversized and partial records", async () => {
    const f = await fixture();
    f.diagnostics.record("runtime.failure", { message: "Runtime shutdown could not confirm owned-process cleanup." });
    const path = join(f.logs, "runtime.log");
    const valid = await readFile(path, "utf8");
    const changed = JSON.parse(valid) as Record<string, unknown>;
    changed.message = "PRIVATE";
    const extra: Record<string, unknown> = { ...changed, extra: "PRIVATE" };
    const payload = JSON.stringify(Object.fromEntries(Object.entries(extra)
      .filter(([key]) => key !== "recordDigest")
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    extra.recordDigest = createHash("sha256").update(payload).digest("hex");
    await writeFile(path, `${JSON.stringify(changed)}\n${JSON.stringify(extra)}\nnot-json\n${"x".repeat(4_097)}\n${valid.trimEnd()}`);
    expect(await readImageSendRuntimeRecords(f.root, signal())).toEqual([]);
  });

  it.each([undefined, "git"] as const)("retains the first restart cause after the record window fills (probe=%s)", async (probe) => {
    const f = await fixture();
    f.diagnostics.record("runtime.restart-requested", { generation: 1, reason: "owned-process-tainted",
      stage: "darwin-guardian-close", signal: "SIGUSR2", exitCode: 0,
      ...(probe ? { probe } : {}),
      argv: ["PRIVATE"], stderr: "PRIVATE", message: "PRIVATE" });
    for (let generation = 0; generation < 40; generation++) f.diagnostics.record("runtime.failure", {
      generation, message: "Runtime shutdown could not confirm owned-process cleanup.",
    });
    const records = await readImageSendRuntimeRecords(f.root, signal());
    expect(records).toHaveLength(32);
    expect(records[0]).toMatchObject({ event: "runtime.restart-requested", generation: 1,
      reason: "owned-process-tainted", stage: "darwin-guardian-close", signal: "SIGUSR2", exitCode: 0 });
    if (probe) expect(records[0]).toMatchObject({ probe });
    expect(records.at(-1)).toMatchObject({ generation: 39, lastErrorCode: "owned-process-cleanup-unconfirmed" });
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE|argv|stderr|message|recordDigest/u);
    const report = f.diagnostics.supportReport({ version: "test", platform: "darwin", architecture: "x64", runtime: null });
    expect(report.text).toContain("stage=darwin-guardian-close");
    expect(report.text).toContain("signal=SIGUSR2");
    if (probe) expect(report.text).toContain(`probe=${probe}`);
  });

  it("bounds known files and keeps only the latest 32 records", async () => {
    const f = await fixture();
    for (let generation = 0; generation < 40; generation++) f.diagnostics.record("runtime.state", { generation });
    await writeFile(join(f.logs, "runtime.1.log"), "x".repeat(256 * 1_024 + 1));
    await writeFile(join(f.logs, "unrelated.log"), "PRIVATE");
    const records = await readImageSendRuntimeRecords(f.root, signal());
    expect(records).toHaveLength(32);
    expect(records[0]?.generation).toBe(8);
    expect(records.at(-1)?.generation).toBe(39);
  });

  it.skipIf(process.platform === "win32")("rejects symlinked log files and directories", async () => {
    const f = await fixture();
    const other = await fixture();
    other.diagnostics.record("runtime.failure", { message: "Runtime shutdown could not confirm owned-process cleanup." });
    await symlink(join(other.logs, "runtime.log"), join(f.logs, "runtime.log"));
    expect(await readImageSendRuntimeRecords(f.root, signal())).toEqual([]);
    const redirected = await mkdtemp(join(tmpdir(), "inertia-image-redirect-"));
    directories.push(redirected);
    await mkdir(join(redirected, "electron-profile"));
    await symlink(join(other.root, "electron-profile", "logs"), join(redirected, "electron-profile", "logs"));
    expect(await readImageSendRuntimeRecords(redirected, signal())).toEqual([]);
  });

  it("stops reading when the diagnostic is cancelled", async () => {
    const f = await fixture();
    await expect(readImageSendRuntimeRecords(f.root, AbortSignal.abort())).rejects.toBeDefined();
  });

  it("captures pre-close state while a dead runtime has no WebSocket", async () => {
    const f = await fixture();
    const attach = vi.fn(async () => undefined);
    await attachImageSendFailureDiagnostics({ attach }, {
      testDirectory: f.root,
      runtimeSnapshot: async () => ({ phase: "stopped", generation: 1, pid: null, websocketUrl: null,
        restartAttempt: 0, restartScheduled: false, lastError: "PRIVATE" }),
    });
    expect(attach).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(attach.mock.calls)).toContain("detail-omitted");
    expect(JSON.stringify(attach.mock.calls)).not.toContain("PRIVATE");
  });

  it("bounds a hung snapshot and reporter and ignores a late private error", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const attach = vi.fn(async () => await new Promise<void>(() => undefined));
    let rejectSnapshot!: (error: Error) => void;
    const pending = attachImageSendFailureDiagnostics({ attach }, {
      testDirectory: f.root,
      runtimeSnapshot: () => new Promise((_resolve, reject) => { rejectSnapshot = reject; }),
    });
    await vi.advanceTimersByTimeAsync(750);
    await pending;
    expect(JSON.stringify(attach.mock.calls)).toContain("timed-out");
    rejectSnapshot(new Error("PRIVATE"));
    await Promise.resolve();
    expect(JSON.stringify(attach.mock.calls)).not.toContain("PRIVATE");
  });
});
