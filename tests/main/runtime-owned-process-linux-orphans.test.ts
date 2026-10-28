import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCleanupReceiptJournal } from "../../src/main/runtime-cleanup-receipts";
import {
  recoverPriorRuntimeGenerations,
  recoverRuntimeOwnedProcesses,
} from "../../src/main/runtime-owned-process-recovery";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import * as orphanReaping from "../../src/node/runtime-owned-process-linux-orphans";
import {
  LINUX_RUNTIME_OWNED_GUARDIAN_MARKER,
  reapLinuxGuardianOrphans,
  scanLinuxGuardianOrphans,
} from "../../src/node/runtime-owned-process-linux-orphans";
import {
  readLinuxProcessIdentity,
  RuntimeOwnedProcessJournal,
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { linuxProcessCanExecute } from "../../src/node/runtime-owned-process-posix";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const linuxIt = process.platform === "linux" ? it : it.skip;
const roots: string[] = [];
const guardian = { pid: 4321, startTimeTicks: "777" };
const marker = `${LINUX_RUNTIME_OWNED_GUARDIAN_MARKER}=${guardian.pid}:${guardian.startTimeTicks}`;
const selfPid = 900;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-linux-orphans-"));
  roots.push(root);
  return root;
}

function statLine(
  pid: number, parentPid: number, startTimeTicks: string, state = "S", name = "agent", session = 1,
): string {
  const fields = Array.from({ length: 20 }, () => "1");
  fields[0] = state;
  fields[1] = String(parentPid);
  fields[2] = String(pid);
  fields[3] = String(session);
  fields[19] = startTimeTicks;
  return `${pid} (${name}) ${fields.join(" ")}\n`;
}

function fakeProc() {
  const procRoot = join(temporaryRoot(), "proc");
  const add = (pid: number, parentPid: number, environ: string[] | null, options: {
    readonly startTimeTicks?: string; readonly state?: string; readonly name?: string;
    readonly session?: number;
  } = {}): void => {
    mkdirSync(join(procRoot, String(pid)), { recursive: true });
    writeFileSync(join(procRoot, String(pid), "stat"), statLine(
      pid, parentPid, options.startTimeTicks ?? String(1_000 + pid), options.state, options.name, options.session,
    ));
    if (environ) writeFileSync(join(procRoot, String(pid), "environ"), `${environ.join("\0")}\0`);
  };
  const remove = (pid: number): void => rmSync(join(procRoot, String(pid)), { recursive: true, force: true });
  add(1, 0, null);
  add(selfPid, 1, ["HOME=/home/person"]);
  return { procRoot, add, remove };
}

describe("Linux orphan scan", () => {
  it("finds only live processes carrying the exact guardian marker", () => {
    const proc = fakeProc();
    proc.add(500, 1, ["PATH=/usr/bin", marker], { name: "agent (tool)" });
    proc.add(501, 1, [`${LINUX_RUNTIME_OWNED_GUARDIAN_MARKER}=${guardian.pid}:778`]);
    proc.add(502, 1, null);
    proc.add(503, selfPid, [marker]);
    proc.add(504, 1, [marker], { state: "Z" });
    proc.add(505, 1, [`${marker}0`]);
    expect(scanLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 1_000, procRoot: proc.procRoot, selfPid,
    })).toEqual({
      complete: true,
      orphans: [{ pid: 500, startTimeTicks: "1500", command: "agent (tool)" }],
    });
  });

  it("never selects the recovering process or its own ancestors", () => {
    const proc = fakeProc();
    proc.add(800, 1, [marker]);
    proc.add(selfPid, 800, [marker]);
    expect(scanLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 1_000, procRoot: proc.procRoot, selfPid,
    }).orphans).toEqual([]);
  });

  it("reports an incomplete scan when the process count or deadline bound is exceeded", () => {
    const proc = fakeProc();
    proc.add(500, 1, [marker]);
    expect(scanLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 1_000, procRoot: proc.procRoot, selfPid, maxProcesses: 2,
    }).complete).toBe(false);
    expect(scanLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() - 1, procRoot: proc.procRoot, selfPid,
    }).complete).toBe(false);
    expect(scanLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 1_000, procRoot: join(proc.procRoot, "missing"), selfPid,
    }).complete).toBe(false);
  });
});

describe("Linux orphan reaping", () => {
  const wait = async (): Promise<void> => undefined;

  it("terminates marked orphans and then proves none remain", async () => {
    const proc = fakeProc();
    proc.add(500, 1, [marker]);
    const kill = vi.fn((pid: number) => proc.remove(pid));
    await expect(reapLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 2_000, procRoot: proc.procRoot, selfPid, kill, wait,
    })).resolves.toEqual({ recovered: true, unsignalled: [] });
    expect(kill.mock.calls).toEqual([[500, "SIGTERM"]]);
  });

  it("kills an orphan that ignores the termination request", async () => {
    const proc = fakeProc();
    proc.add(500, 1, [marker]);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") proc.remove(pid);
    });
    await expect(reapLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 2_000, procRoot: proc.procRoot, selfPid, kill, wait,
    })).resolves.toEqual({ recovered: true, unsignalled: [] });
    expect(kill.mock.calls).toEqual([[500, "SIGTERM"], [500, "SIGKILL"]]);
  });

  it("reports an orphan it is not permitted to signal and stays unrecovered", async () => {
    const proc = fakeProc();
    proc.add(500, 1, [marker], { name: "sudo" });
    proc.add(501, 1, [marker]);
    const kill = vi.fn((pid: number) => {
      if (pid === 500) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      proc.remove(pid);
    });
    await expect(reapLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 2_000, procRoot: proc.procRoot, selfPid, kill, wait,
    })).resolves.toEqual({
      recovered: false,
      unsignalled: [{ pid: 500, startTimeTicks: "1500", command: "sudo" }],
    });
    expect(kill).toHaveBeenCalledWith(501, "SIGTERM");
  });

  it("keeps a live guardian session member without a readable marker unrecovered and reports it", async () => {
    const proc = fakeProc();
    proc.add(600, 1, null, { name: "sleep", session: guardian.pid });
    proc.add(601, 1, null, { session: guardian.pid, state: "Z" });
    const kill = vi.fn();
    await expect(reapLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 2_000, procRoot: proc.procRoot, selfPid, kill, wait,
      reusedHolderStartTimeTicks: null,
    })).resolves.toEqual({
      recovered: false,
      unsignalled: [{ pid: 600, startTimeTicks: "1600", command: "sleep" }],
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("ignores session members that predate the guardian or belong to a reused holder", async () => {
    const proc = fakeProc();
    proc.add(600, 1, null, { session: guardian.pid, startTimeTicks: "776" });
    proc.add(601, 1, null, { session: guardian.pid, startTimeTicks: "5000" });
    await expect(reapLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 2_000, procRoot: proc.procRoot, selfPid, kill: vi.fn(), wait,
      reusedHolderStartTimeTicks: "5000",
    })).resolves.toEqual({ recovered: true, unsignalled: [] });
  });

  it("does not signal a process whose identity changed after the snapshot", async () => {
    const proc = fakeProc();
    proc.add(500, 1, [marker]);
    const kill = vi.fn();
    const snapshot = scanLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 1_000, procRoot: proc.procRoot, selfPid,
    });
    expect(snapshot.orphans).toHaveLength(1);
    proc.remove(500);
    proc.add(500, 1, ["HOME=/home/person"], { startTimeTicks: "9999" });
    await expect(reapLinuxGuardianOrphans(guardian, {
      deadlineAt: Date.now() + 2_000, procRoot: proc.procRoot, selfPid, kill, wait,
    })).resolves.toEqual({ recovered: true, unsignalled: [] });
    expect(kill).not.toHaveBeenCalled();
  });
});

function linuxRecoveryFixture(): { dataDirectory: string; ownershipId: string; guardianPath: string } {
  const dataDirectory = temporaryRoot();
  const guardianPath = join(dataDirectory, "guardian");
  writeFileSync(guardianPath, "fixture, never executed", { mode: 0o700 });
  const generation = "73000000-0000-4000-8000-000000000073:1";
  const boot = "test:74000000-0000-4000-8000-000000000074";
  expect(new RuntimeOwnedProcessJournal(dataDirectory, { platform: "linux", darwinGuardianPath: guardianPath })
    .startSession(generation, boot)).toBe(true);
  const executable = statSync(guardianPath, { bigint: true });
  const ownershipId = randomUUID();
  writeFileSync(join(dataDirectory, `.runtime-owned-child-${ownershipId}.json`), JSON.stringify({
    version: 1,
    state: "owned",
    ownershipId,
    runtimeGenerationId: generation,
    systemBootId: boot,
    process: {
      pid: guardian.pid,
      parentPid: 4000,
      processGroupId: guardian.pid,
      startTimeTicks: guardian.startTimeTicks,
      guardianExecutableDevice: String(executable.dev),
      guardianExecutableInode: String(executable.ino),
    },
  }), { encoding: "utf8", mode: 0o600 });
  return { dataDirectory, ownershipId, guardianPath };
}

describe("Linux missing-guardian recovery without cgroup proof", () => {
  const generation = "73000000-0000-4000-8000-000000000073:1";
  const boot = "test:74000000-0000-4000-8000-000000000074";

  it("retires the record once its marked orphans are gone", async () => {
    const { dataDirectory, guardianPath } = linuxRecoveryFixture();
    const reap = vi.fn(async () => ({ recovered: true, unsignalled: [] }));
    await expect(recoverRuntimeOwnedProcesses(dataDirectory, generation, boot, {
      deadlineAt: Date.now() + 2_000,
      platform: "linux",
      darwinGuardianPath: guardianPath,
      readIdentity: () => null,
      linuxGuardianTreeGone: () => false,
      reapLinuxGuardianOrphans: reap,
    })).resolves.toBe(true);
    expect(reap).toHaveBeenCalledWith(
      expect.objectContaining({ pid: guardian.pid, startTimeTicks: guardian.startTimeTicks }),
      expect.objectContaining({ deadlineAt: expect.any(Number), reusedHolderStartTimeTicks: null }),
    );
    expect(new RuntimeOwnedProcessJournal(dataDirectory, { platform: "linux", darwinGuardianPath: guardianPath })
      .records(generation)).toEqual([]);
  });

  it("keeps the record and reports orphans it could not signal", async () => {
    const { dataDirectory, ownershipId, guardianPath } = linuxRecoveryFixture();
    const unsignalled = [{ pid: 500, startTimeTicks: "1500", command: "sudo" }];
    const onUnsignalledOrphans = vi.fn();
    await expect(recoverRuntimeOwnedProcesses(dataDirectory, generation, boot, {
      deadlineAt: Date.now() + 2_000,
      platform: "linux",
      darwinGuardianPath: guardianPath,
      readIdentity: () => null,
      linuxGuardianTreeGone: () => false,
      reapLinuxGuardianOrphans: async () => ({ recovered: false, unsignalled }),
      onUnsignalledOrphans,
    })).resolves.toBe(false);
    expect(onUnsignalledOrphans).toHaveBeenCalledExactlyOnceWith(unsignalled);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, { platform: "linux", darwinGuardianPath: guardianPath })
      .records(generation)?.map((record) => record.ownershipId)).toEqual([ownershipId]);
  });

  it("reports unsignalled orphans from startup recovery of prior generations", async () => {
    const { dataDirectory, guardianPath } = linuxRecoveryFixture();
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(generation, boot)).toBe(true);
    const unsignalled = [{ pid: 500, startTimeTicks: "1500", command: "sudo" }];
    vi.spyOn(orphanReaping, "reapLinuxGuardianOrphans").mockResolvedValue({ recovered: false, unsignalled });
    const onUnsignalledOrphans = vi.fn();
    await expect(recoverPriorRuntimeGenerations({
      dataDirectory,
      systemBootId: boot,
      deadlineAt: Date.now() + 2_000,
      leases,
      receipts: new RuntimeCleanupReceiptJournal(dataDirectory),
      platform: "linux",
      darwinGuardianPath: guardianPath,
      onUnsignalledOrphans,
    })).resolves.toBe(false);
    expect(onUnsignalledOrphans).toHaveBeenCalledExactlyOnceWith(unsignalled);
  });

  it("prefers cgroup proof and does not scan when it is available", async () => {
    const { dataDirectory, guardianPath } = linuxRecoveryFixture();
    const reap = vi.fn(async () => ({ recovered: false, unsignalled: [] }));
    await expect(recoverRuntimeOwnedProcesses(dataDirectory, generation, boot, {
      deadlineAt: Date.now() + 2_000,
      platform: "linux",
      darwinGuardianPath: guardianPath,
      readIdentity: () => null,
      linuxGuardianTreeGone: () => true,
      reapLinuxGuardianOrphans: reap,
    })).resolves.toBe(true);
    expect(reap).not.toHaveBeenCalled();
  });
});

describe("Linux guardian orphan marker", () => {
  const guardianPath = join(
    process.cwd(),
    "resources/generated/runtime-process-guardian/runtime-process-guardian",
  );

  linuxIt("gives every guarded payload the exact guardian identity marker", async () => {
    const root = temporaryRoot();
    const output = join(root, "marker");
    const generation = "75000000-0000-4000-8000-000000000075:1";
    const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      root, generation, "test:76000000-0000-4000-8000-000000000076",
      { platform: "linux", darwinGuardianPath: guardianPath },
    );
    try {
      const invocation = runtimeOwnedProcessInvocation("/bin/sh", [
        "-c", `printf '%s' "$${LINUX_RUNTIME_OWNED_GUARDIAN_MARKER}" > '${output}'`,
      ]);
      const child = spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args, {
        detached: true, stdio: "ignore",
      }));
      const guardianIdentity = readLinuxProcessIdentity(child.pid!);
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      expect(guardianIdentity).not.toBeNull();
      expect(readFileSync(output, "utf8")).toBe(`${child.pid}:${guardianIdentity!.startTimeTicks}`);
    } finally {
      deactivate?.();
    }
  });

  linuxIt("reaps a real marked orphan of a vanished guardian", async () => {
    const vanished = spawnSync("/bin/sh", ["-c", "cut -d' ' -f1,22 /proc/self/stat"], { encoding: "utf8" })
      .stdout.trim().split(" ");
    const missing = { pid: Number(vanished[0]), startTimeTicks: vanished[1]! };
    const launched = spawnSync("/bin/sh", ["-c", "/bin/sleep 30 >/dev/null 2>&1 & echo $!"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", [LINUX_RUNTIME_OWNED_GUARDIAN_MARKER]: `${missing.pid}:${missing.startTimeTicks}` },
    });
    const orphanPid = Number(launched.stdout.trim());
    const orphan = readLinuxProcessIdentity(orphanPid);
    try {
      expect(orphan).not.toBeNull();
      expect(scanLinuxGuardianOrphans(missing, { deadlineAt: Date.now() + 1_000 }).orphans
        .map(({ pid }) => pid)).toEqual([orphanPid]);
      await expect(reapLinuxGuardianOrphans(missing, { deadlineAt: Date.now() + 2_000 }))
        .resolves.toEqual({ recovered: true, unsignalled: [] });
      expect(linuxProcessCanExecute(orphanPid)).toBe(false);
    } finally {
      if (orphan && readLinuxProcessIdentity(orphanPid)?.startTimeTicks === orphan.startTimeTicks) {
        process.kill(orphanPid, "SIGKILL");
      }
    }
  });
});
