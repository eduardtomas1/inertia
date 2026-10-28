import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as linuxGuardian from "../../src/node/runtime-owned-process-linux";
import { releaseFailedPidClaimIfStopped } from "../../src/node/runtime-owned-process-release";
import {
  linuxAdmissionFailureTaintsRegistry,
  linuxGuardianHasRootDescendant,
} from "../../src/node/runtime-owned-process-linux-policy";
import {
  requestRuntimeOwnedGuardianStop,
  runtimeOwnedProcessCleanupConfirmed,
  runtimeOwnedProcessOwnershipIsTainted,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedProcess,
  type RuntimeOwnedProcessClaim,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const roots: string[] = [];
const deactivations: Array<() => void> = [];
const generation = "61000000-0000-4000-8000-000000000061:1";
const boot = "test:62000000-0000-4000-8000-000000000062";

afterEach(() => {
  for (const deactivate of deactivations.splice(0)) deactivate();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-linux-policy-"));
  roots.push(root);
  return root;
}

interface Harness {
  readonly guardian: string;
  readonly identity: linuxGuardian.LinuxGuardianExecutableIdentity & {
    readonly pid: number;
    readonly parentPid: number;
    readonly processGroupId: number;
    readonly startTimeTicks: string;
  };
  readonly onTainted: ReturnType<typeof vi.fn>;
  readonly onProcessFault: ReturnType<typeof vi.fn>;
  readonly monitorFailures: Array<(reason: linuxGuardian.LinuxGuardianMonitorFailure) => void>;
  readonly records: Map<string, RuntimeOwnedProcessClaim | { readonly state: "pending"; readonly ownershipId: string }>;
  spawn(): ChildProcess;
}

function linuxRegistryHarness(): Harness {
  const root = temporaryRoot();
  const guardian = join(root, "guardian");
  writeFileSync(guardian, "fixture, never executed", { mode: 0o700 });
  const executable = statSync(guardian, { bigint: true });
  const identity = {
    pid: 4242,
    parentPid: process.pid,
    processGroupId: 4242,
    startTimeTicks: "456",
    guardianExecutableDevice: String(executable.dev),
    guardianExecutableInode: String(executable.ino),
  };
  const records: Harness["records"] = new Map();
  const claimFor = (ownershipId: string, state: RuntimeOwnedProcessClaim["state"]): RuntimeOwnedProcessClaim => ({
    version: 1, state, ownershipId, runtimeGenerationId: generation, systemBootId: boot, process: identity,
  } as RuntimeOwnedProcessClaim);
  vi.spyOn(RuntimeOwnedProcessJournal.prototype, "begin").mockImplementation(() => {
    const ownershipId = crypto.randomUUID();
    records.set(ownershipId, { state: "pending", ownershipId });
    return ownershipId;
  });
  vi.spyOn(RuntimeOwnedProcessJournal.prototype, "claim").mockImplementation((ownershipId) => {
    const claim = claimFor(ownershipId, "preauth");
    records.set(ownershipId, claim);
    return claim;
  });
  vi.spyOn(RuntimeOwnedProcessJournal.prototype, "own").mockImplementation((ownershipId) => {
    const claim = claimFor(ownershipId, "owned");
    records.set(ownershipId, claim);
    return claim;
  });
  vi.spyOn(RuntimeOwnedProcessJournal.prototype, "records")
    .mockImplementation(() => [...records.values()] as never);
  vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release").mockImplementation((ownershipId) => records.delete(ownershipId));
  vi.spyOn(linuxGuardian, "readLinuxGuardianReadyWithRetriesAsync").mockResolvedValue(identity);
  vi.spyOn(linuxGuardian, "signalLinuxGuardianExactAsync").mockResolvedValue(true);
  vi.spyOn(linuxGuardian, "readLinuxGuardianClaimedAsync").mockResolvedValue(null);
  vi.spyOn(linuxGuardian, "readLinuxGuardianOwnedAsync").mockResolvedValue(null);
  vi.spyOn(linuxGuardian, "stopPendingLinuxGuardianAsync").mockResolvedValue(true);
  vi.spyOn(linuxGuardian, "linuxGuardianTerminalAuthority").mockReturnValue(false);
  const monitorFailures: Harness["monitorFailures"] = [];
  vi.spyOn(linuxGuardian, "monitorLinuxGuardianTerminal").mockImplementation((_expected, _path, _terminal, onFailure) => {
    monitorFailures.push(onFailure);
    return Object.assign(() => undefined, { wake: () => undefined });
  });
  const onTainted = vi.fn();
  const onProcessFault = vi.fn();
  const deactivate = activatePreparedRuntimeOwnedProcessRegistry(root, generation, boot, {
    platform: "linux", darwinGuardianPath: guardian, onTainted, onProcessFault,
  });
  if (deactivate) deactivations.push(deactivate);
  return {
    guardian,
    identity,
    onTainted,
    onProcessFault,
    monitorFailures,
    records,
    spawn: () => spawnRuntimeOwnedProcess(() => Object.assign(new EventEmitter(), {
      pid: identity.pid, spawnfile: guardian, stdout: null, stderr: null,
    }) as unknown as ChildProcess),
  };
}

describe("Linux owned-process admission policy", () => {
  it.each([
    ["linux-readiness", false],
    ["linux-claim", false],
    ["linux-authorization", false],
    ["linux-stop", false],
    ["linux-durable-claim", true],
    ["linux-durable-authorization", true],
  ] as const)("treats an admission failure at %s as registry corruption: %s", (stage, taints) => {
    expect(linuxAdmissionFailureTaintsRegistry(stage)).toBe(taints);
  });

  it("rejects only the spawn whose guardian never becomes ready", async () => {
    const harness = linuxRegistryHarness();
    vi.mocked(linuxGuardian.readLinuxGuardianReadyWithRetriesAsync).mockResolvedValueOnce(null);
    harness.spawn();
    await vi.waitFor(() => expect(harness.onProcessFault).toHaveBeenCalled());
    expect(harness.onProcessFault).toHaveBeenCalledExactlyOnceWith({
      kind: "admission-rejected", diagnostic: { stage: "linux-readiness" },
    });
    expect(linuxGuardian.stopPendingLinuxGuardianAsync).toHaveBeenCalledWith(
      harness.identity.pid, harness.guardian, process.pid, undefined, expect.any(Object),
    );
    expect(harness.onTainted).not.toHaveBeenCalled();
    expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
    expect(() => harness.spawn()).not.toThrow();
  });

  it.each([
    ["claim", "linux-claim"],
    ["exec", "linux-authorization"],
  ] as const)("stops and rejects only the spawn whose %s signal is not confirmed", async (action, stage) => {
    const harness = linuxRegistryHarness();
    vi.mocked(linuxGuardian.signalLinuxGuardianExactAsync).mockImplementation(
      async (_identity, _path, requested) => requested !== action,
    );
    harness.spawn();
    await vi.waitFor(() => expect(harness.onProcessFault).toHaveBeenCalled());
    expect(harness.onProcessFault).toHaveBeenCalledExactlyOnceWith({
      kind: "admission-rejected", diagnostic: { stage },
    });
    expect(linuxGuardian.signalLinuxGuardianExactAsync).toHaveBeenCalledWith(
      harness.identity, harness.guardian, "stop",
    );
    expect(harness.onTainted).not.toHaveBeenCalled();
    expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
  });

  it("quarantines only the spawn whose requested stop cannot be confirmed", async () => {
    const harness = linuxRegistryHarness();
    vi.mocked(linuxGuardian.signalLinuxGuardianExactAsync).mockImplementation(
      async (_identity, _path, requested) => requested !== "stop",
    );
    const child = harness.spawn();
    await expect(requestRuntimeOwnedGuardianStop(child)).resolves.toBe(false);
    expect(harness.onProcessFault).toHaveBeenCalledExactlyOnceWith({
      kind: "quarantined", diagnostic: { stage: "linux-stop" },
    });
    expect(linuxGuardian.signalLinuxGuardianExactAsync).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "exec", expect.anything(),
    );
    expect(harness.onTainted).not.toHaveBeenCalled();
    expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
  });

  it("abandons a stopped spawn's admission at the immediate-stop admission budget", async () => {
    vi.useFakeTimers();
    try {
      const harness = linuxRegistryHarness();
      vi.mocked(linuxGuardian.readLinuxGuardianReadyWithRetriesAsync).mockImplementation(
        async (_pid, _path, _parent, signal) => await new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), { once: true });
        }),
      );
      const child = harness.spawn();
      let stopped: boolean | undefined;
      void requestRuntimeOwnedGuardianStop(child)?.then((value) => { stopped = value; });
      await vi.advanceTimersByTimeAsync(
        linuxGuardian.LINUX_RUNTIME_OWNED_GUARDIAN_IMMEDIATE_STOP_ADMISSION_TIMEOUT_MS - 1,
      );
      expect(stopped).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(false);
      expect(harness.onProcessFault).toHaveBeenCalledExactlyOnceWith({
        kind: "admission-rejected", diagnostic: { stage: "linux-readiness" },
      });
      expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a slow admission finish when no stop is requested", async () => {
    vi.useFakeTimers();
    try {
      const harness = linuxRegistryHarness();
      vi.mocked(linuxGuardian.readLinuxGuardianReadyWithRetriesAsync).mockImplementation(
        async () => await new Promise((resolve) => {
          setTimeout(() => resolve(harness.identity), 9_000);
        }),
      );
      harness.spawn();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(linuxGuardian.signalLinuxGuardianExactAsync).toHaveBeenCalledWith(
        harness.identity, harness.guardian, "exec", expect.anything(),
      );
      expect(harness.onProcessFault).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still taints the registry when the durable claim cannot be persisted", async () => {
    const harness = linuxRegistryHarness();
    vi.mocked(RuntimeOwnedProcessJournal.prototype.claim).mockImplementationOnce(() => {
      throw new Error("The spawned process ownership could not be persisted.");
    });
    harness.spawn();
    await vi.waitFor(() => expect(harness.onTainted).toHaveBeenCalled());
    expect(harness.onTainted).toHaveBeenCalledExactlyOnceWith({ stage: "linux-durable-claim" });
    expect(harness.onProcessFault).not.toHaveBeenCalled();
    expect(() => harness.spawn()).toThrow("tainted until restart");
  });

  it("still taints the registry when the owned authorization cannot be persisted", async () => {
    const harness = linuxRegistryHarness();
    vi.mocked(RuntimeOwnedProcessJournal.prototype.own).mockReturnValueOnce(null);
    harness.spawn();
    await vi.waitFor(() => expect(harness.onTainted).toHaveBeenCalled());
    expect(harness.onTainted).toHaveBeenCalledExactlyOnceWith({ stage: "linux-durable-authorization" });
    expect(harness.onProcessFault).not.toHaveBeenCalled();
  });
});

describe("Linux owned-process monitor policy", () => {
  it.each([
    ["bad-terminal", "quarantined"],
    ["unproved-terminal", "quarantined"],
    ["unreadable", "quarantined"],
  ] as const)("quarantines only the process whose monitor reports %s", async (reason, kind) => {
    const harness = linuxRegistryHarness();
    harness.spawn();
    await vi.waitFor(() => expect(harness.monitorFailures).toHaveLength(1));
    await vi.waitFor(() => expect([...harness.records.values()].map(({ state }) => state)).toEqual(["owned"]));
    harness.monitorFailures[0]!(reason);

    expect(harness.onProcessFault).toHaveBeenCalledExactlyOnceWith({
      kind, diagnostic: { stage: "linux-guardian-monitor" },
    });
    expect(harness.onTainted).not.toHaveBeenCalled();
    expect(runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
    expect([...harness.records.values()].map(({ state }) => state)).toEqual(["owned"]);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(false);
    expect(() => harness.spawn()).not.toThrow();
  });
});

describe("Linux rejected admission retirement", () => {
  it("retries retirement when the stopped guardian exits after the first bounded wait", async () => {
    const ownershipId = "63000000-0000-4000-8000-000000000063";
    const release = vi.fn(() => true);
    const registry = {
      active: true,
      platform: "linux",
      runtimeGenerationId: generation,
      systemBootId: boot,
      pendingReleaseConfirmations: new Set<Promise<boolean>>(),
      journal: {
        records: () => [{ state: "pending", ownershipId, runtimeGenerationId: generation, systemBootId: boot }],
        release,
      },
    } as unknown as Parameters<typeof releaseFailedPidClaimIfStopped>[0];
    const claim = {
      ownershipId, released: false, releaseConfirmation: null, settleReleaseConfirmation: null,
    } as unknown as Parameters<typeof releaseFailedPidClaimIfStopped>[1];
    const absentGroup = 2_000_000_000;

    await expect(releaseFailedPidClaimIfStopped(registry, claim, absentGroup, () => true)).resolves.toBe(false);
    expect(release).not.toHaveBeenCalled();
    await expect(releaseFailedPidClaimIfStopped(registry, claim, absentGroup, () => false)).resolves.toBe(true);
    expect(release).toHaveBeenCalledExactlyOnceWith(ownershipId);
    expect(claim.released).toBe(true);
  });
});

describe("Linux guardian helper deadlines", () => {
  function helperScript(source: string): { readonly path: string; readonly identity: Harness["identity"] } {
    const root = temporaryRoot();
    const path = join(root, "guardian");
    writeFileSync(path, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
    const executable = statSync(path, { bigint: true });
    return {
      path,
      identity: {
        pid: 4242, parentPid: process.pid, processGroupId: 4242, startTimeTicks: "456",
        guardianExecutableDevice: String(executable.dev),
        guardianExecutableInode: String(executable.ino),
      },
    };
  }

  it.skipIf(process.platform === "win32")("lets a helper delayed by a slow disk finish instead of killing it", async () => {
    const helper = helperScript("sleep 3\nexit 0");
    const startedAt = Date.now();
    await expect(linuxGuardian.signalLinuxGuardianExactAsync(helper.identity, helper.path, "claim"))
      .resolves.toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_900);
  });

  it.skipIf(process.platform === "win32")("keeps probing readiness for the whole readiness window", async () => {
    const root = temporaryRoot();
    const attempts = join(root, "attempts");
    const helper = helperScript(`printf x >> '${attempts}'\nsleep 0.3\nexit 4`);
    const startedAt = Date.now();
    await expect(linuxGuardian.readLinuxGuardianReadyWithRetriesAsync(4242, helper.path, process.pid))
      .resolves.toBeNull();
    const elapsedMs = Date.now() - startedAt;
    expect(readFileSync(attempts, "utf8").length).toBeGreaterThan(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(linuxGuardian.LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS - 100);
    expect(elapsedMs).toBeLessThan(linuxGuardian.LINUX_RUNTIME_OWNED_GUARDIAN_HELPER_TIMEOUT_MS + 2_000);
  });

  it("stops probing readiness once admission is aborted", async () => {
    const helper = helperScript("sleep 0.2\nexit 4");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const startedAt = Date.now();
    await expect(linuxGuardian.readLinuxGuardianReadyWithRetriesAsync(
      4242, helper.path, process.pid, abort.signal,
    )).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});

describe("Linux guardian terminal monitor", () => {
  const expected = {
    pid: 123, parentPid: 1, processGroupId: 123, startTimeTicks: "456",
    guardianExecutableDevice: "1", guardianExecutableInode: "2",
  };

  it("waits out a slow seccomp and stop transition before calling a terminal unproved", () => {
    vi.useFakeTimers();
    let hardened = false;
    const onTerminal = vi.fn(() => true);
    const onFailure = vi.fn();
    const stop = linuxGuardian.monitorLinuxGuardianTerminal(expected, "/trusted/guardian", onTerminal, onFailure, {
      readComm: () => "inertia-done", terminalAuthority: () => hardened, release: () => true,
    });
    try {
      vi.advanceTimersByTime(2_000);
      hardened = true;
      vi.advanceTimersByTime(50);
      expect(onFailure).not.toHaveBeenCalled();
      expect(onTerminal).toHaveBeenCalledWith(false);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("restarts the unproved-terminal bound after hardened authority is observed", () => {
    vi.useFakeTimers();
    let hardened = false;
    const onFailure = vi.fn();
    const stop = linuxGuardian.monitorLinuxGuardianTerminal(expected, "/trusted/guardian", () => false, onFailure, {
      readComm: () => "inertia-done", terminalAuthority: () => hardened, release: () => true,
    });
    try {
      vi.advanceTimersByTime(linuxGuardian.LINUX_GUARDIAN_UNPROVED_TERMINAL_MS - 100);
      hardened = true;
      vi.advanceTimersByTime(50);
      hardened = false;
      vi.advanceTimersByTime(linuxGuardian.LINUX_GUARDIAN_UNPROVED_TERMINAL_MS - 100);
      expect(onFailure).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(onFailure).toHaveBeenCalledExactlyOnceWith("unproved-terminal");
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it.each([
    ["inertia-bad", "bad-terminal"],
    [null, "unreadable"],
  ] as const)("names the monitor failure for %s", (comm, reason) => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const stop = linuxGuardian.monitorLinuxGuardianTerminal(expected, "/trusted/guardian", () => true, onFailure, {
      readComm: () => {
        if (comm === null) throw new Error("EACCES");
        return comm;
      },
      terminalAuthority: () => true,
      release: () => true,
      missing: () => false,
    });
    try {
      vi.advanceTimersByTime(50);
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(reason);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});

describe("Linux root-owned descendant detection", () => {
  function procFixture(children: Record<string, string>): string {
    const procRoot = join(temporaryRoot(), "proc");
    mkdirSync(join(procRoot, "100", "task", "100"), { recursive: true });
    writeFileSync(join(procRoot, "100", "task", "100", "children"), `${Object.keys(children).join(" ")} `);
    for (const [pid, uid] of Object.entries(children)) {
      mkdirSync(join(procRoot, pid), { recursive: true });
      writeFileSync(join(procRoot, pid, "status"), `Name:\tsudo\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    }
    return procRoot;
  }

  it("finds a child whose real user is root", () => {
    expect(linuxGuardianHasRootDescendant(100, procFixture({ 101: "1000", 102: "0" }))).toBe(true);
  });

  it("ignores children of the same user and unreadable process state", () => {
    expect(linuxGuardianHasRootDescendant(100, procFixture({ 101: "1000" }))).toBe(false);
    expect(linuxGuardianHasRootDescendant(100, join(temporaryRoot(), "missing"))).toBe(false);
  });
});
