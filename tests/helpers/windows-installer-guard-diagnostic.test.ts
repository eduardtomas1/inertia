import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInstallerGuardTrace, INSTALLER_GUARD_DIAGNOSTIC_MS,
  INSTALLER_GUARD_QUERY_BYTES, INSTALLER_GUARD_TRACE_LIMIT,
  projectInstallerGuardQuery, readInstallerGuardQuery, reportInstallerGuardFailure,
} from "./windows-installer-guard-diagnostic";

describe("Windows installer guard failure evidence", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("retains pending probe identity, spawn and phase timing without changing results or errors", async () => {
    const trace = createInstallerGuardTrace("external-only");
    await expect(trace.step("compiler-lookup", async () => 42)).resolves.toBe(42);
    let finish!: (value: number) => void;
    const pending = trace.step("guard", () => new Promise<number>((resolve) => { finish = resolve; }), {
      probe: { index: 2, expectedCode: 0, root: "fresh" },
    });
    trace.spawned(1234);
    const snapshot = trace.snapshot([], []);
    expect(snapshot.modulePaths).toBe("external-only");
    expect(snapshot.pendingPhase).toMatchObject({ phase: "guard", outcome: "pending", endMs: null,
      ownedPid: 1234, spawnedAtMs: expect.any(Number),
      probe: { index: 2, expectedCode: 0, root: "fresh" } });
    finish(7);
    await expect(pending).resolves.toBe(7);
    expect(snapshot.pendingPhase?.outcome).toBe("pending");
    expect(trace.snapshot([], []).pendingPhase).toBeNull();
    const original = new Error("private command and credentials");
    await expect(trace.step("root-removal", async () => { throw original; })).rejects.toBe(original);
    expect(() => trace.check("blocker-assertions", () => { throw original; })).toThrow(original);
    expect(trace.snapshot([], []).trace.slice(-2).map((entry) => entry.outcome)).toEqual(["rejected", "rejected"]);
    for (const entry of trace.snapshot([], []).trace) {
      expect(entry.endMs).toBeGreaterThanOrEqual(entry.startMs);
    }
    expect(JSON.stringify(trace.snapshot([], []))).not.toContain("private");
  });

  it("caps retained phases, children and completed probes and projects only allowed fields", () => {
    const trace = createInstallerGuardTrace();
    const context = { blockerIndex: 1, environment: "private environment",
      probe: { index: 0, expectedCode: 1, root: "installed" as const, command: "private command" } };
    for (let index = 0; index < 100; index += 1) trace.check("blocker-assertions", () => undefined, context);
    const child = { pid: 123, exitCode: null, signalCode: "private signal", stdin: { destroyed: false },
      spawnargs: ["private args"], env: "private environment" } as unknown as ChildProcess;
    const probe = { expectedCode: 1, exitCode: 1, elapsedMs: 123,
      queryResult: "0", powerShellPath: "C:\\private directory\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe" };
    const snapshot = trace.snapshot(Array.from({ length: 100 }, () => child), Array.from({ length: 100 }, () => probe));
    expect(snapshot.trace).toHaveLength(INSTALLER_GUARD_TRACE_LIMIT);
    expect(snapshot.dropped).toBe(100 - INSTALLER_GUARD_TRACE_LIMIT);
    expect(snapshot.children).toHaveLength(2);
    expect(snapshot.children[0]).toEqual({ index: 0, pid: 123, exitCode: null, signalCode: "other", stdinDestroyed: false });
    expect(snapshot.completedProbes).toHaveLength(4);
    expect(snapshot.completedProbes[0]).toMatchObject({ queryResult: "0", powerShell: "native-sysnative" });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|spawnargs|environment|command/u);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(16 * 1024);
  });

  it("reads only a bounded prefix of regular fixture files and never emits raw paths or text", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-guard-diagnostic-"));
    roots.push(root);
    const file = join(root, "query-result-0.txt");
    await writeFile(file, "1\r\nC:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe");
    await expect(readInstallerGuardQuery(file)).resolves.toEqual({ state: "read",
      queryResult: "1", powerShell: "native-sysnative" });
    await writeFile(file, `secret query\nC:\\secret-directory\\private.exe\n${"secret".repeat(INSTALLER_GUARD_QUERY_BYTES)}`);
    const result = await readInstallerGuardQuery(file);
    expect(result).toEqual({ state: "truncated", queryResult: "unrecognized", powerShell: "other" });
    expect(JSON.stringify(result)).not.toContain("secret");
    await expect(readInstallerGuardQuery(root)).resolves.toEqual({ state: "not-regular" });
    expect(projectInstallerGuardQuery("timeout\n")).toEqual({ queryResult: "timeout", powerShell: "absent" });
    expect(projectInstallerGuardQuery("2\nC:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
      .toEqual({ queryResult: "2", powerShell: "system32" });
  });

  it("reports a failed read without its error text and preserves failure through a rejecting writer", async () => {
    const trace = createInstallerGuardTrace();
    const write = vi.fn();
    const readQuery = vi.fn(async () => { throw new Error("secret file path"); });
    await reportInstallerGuardFailure(trace, "/secret-root", [], [], { readQuery, write });
    expect(readQuery).toHaveBeenCalledTimes(4);
    const line = write.mock.calls[0][0] as string;
    expect(line).toContain('"state":"unavailable"');
    expect(line).not.toContain("secret");
    expect(Buffer.byteLength(line)).toBeLessThan(16 * 1024);
    const original = new Error("the assertion failed");
    const cleaned = vi.fn();
    const scenario = async () => {
      try {
        try { throw original; }
        catch (error) {
          await reportInstallerGuardFailure(trace, "/secret-root", [], [], {
            readQuery, write: async () => { throw new Error("secret reporting failure"); },
          });
          throw error;
        }
      } finally { cleaned(); }
    };
    await expect(scenario()).rejects.toBe(original);
    expect(cleaned).toHaveBeenCalledOnce();
  });

  it("consumes a late diagnostic rejection after its deadline", async () => {
    vi.useFakeTimers();
    const trace = createInstallerGuardTrace();
    let reject!: (error: Error) => void;
    const lateRead = new Promise<never>((_, rejectRead) => { reject = rejectRead; });
    const write = vi.fn();
    const report = reportInstallerGuardFailure(trace, "/private-root", [], [], {
      readQuery: () => lateRead, write,
    });
    await vi.advanceTimersByTimeAsync(INSTALLER_GUARD_DIAGNOSTIC_MS);
    await expect(report).resolves.toBeUndefined();
    expect(write.mock.calls[0][0]).toContain('"outcome":"timed-out"');
    reject(new Error("private late rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["read", "write", "both"] as const)("bounds a hanging %s diagnostic without replacing failure or holding cleanup", async (hang) => {
    vi.useFakeTimers();
    const trace = createInstallerGuardTrace();
    const original = new Error("the assertion failed");
    const cleaned = vi.fn();
    const write = vi.fn(async () => {
      if (hang !== "read") await new Promise<never>(() => undefined);
    });
    const scenario = async () => {
      try {
        try { throw original; }
        catch (error) {
          await reportInstallerGuardFailure(trace, "/private-root", [], [], {
            readQuery: async () => hang === "write" ? { state: "not-regular" }
              : await new Promise<never>(() => undefined),
            write,
          });
          throw error;
        }
      } finally { cleaned(); }
    };
    const result = expect(scenario()).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(INSTALLER_GUARD_DIAGNOSTIC_MS * 2);
    await result;
    expect(cleaned).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
