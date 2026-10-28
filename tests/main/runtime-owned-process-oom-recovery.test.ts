import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverRuntimeOwnedProcesses } from "../../src/main/runtime-owned-process-recovery";
import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import {
  LINUX_INIT_CGROUP_NAMESPACE,
  linuxGuardianProcessTreeGone,
  readLinuxProcessCgroup,
} from "../../src/node/runtime-owned-process-linux-cgroup";
import { LINUX_RUNTIME_OWNED_GUARDIAN_MARKER } from "../../src/node/runtime-owned-process-linux-orphans";
import { linuxProcessCanExecute } from "../../src/node/runtime-owned-process-posix";
import { runtimeOwnedProcessWriterName } from
  "../../src/node/runtime-owned-process-session-journal";
import {
  readLinuxProcessIdentity,
  RuntimeOwnedProcessJournal,
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const bootId = "test:00000000-0000-4000-8000-000000000071";
const priorGeneration = "71000000-0000-4000-8000-000000000071:1";
const guardianPath = join(
  process.cwd(),
  "resources/generated/runtime-process-guardian/runtime-process-guardian",
);
const cgroup2 = () => 0x63677270;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

function statLine(pid: number, session: number, startTimeTicks: string): string {
  const fields = Array.from({ length: 20 }, () => "1");
  fields[0] = "S";
  fields[2] = String(pid);
  fields[3] = String(session);
  fields[19] = startTimeTicks;
  return `${pid} (agent (tool)) ${fields.join(" ")}\n`;
}

function fakeHost(options: { namespace?: string } = {}) {
  const root = temporaryDirectory("inertia-cgroup-host-");
  const procRoot = join(root, "proc");
  const cgroupRoot = join(root, "cgroup");
  mkdirSync(join(procRoot, "self", "ns"), { recursive: true });
  symlinkSync(
    options.namespace ?? LINUX_INIT_CGROUP_NAMESPACE,
    join(procRoot, "self", "ns", "cgroup"),
  );
  mkdirSync(cgroupRoot);
  writeFileSync(join(cgroupRoot, "cgroup.procs"), "");
  return {
    probe: { procRoot, cgroupRoot, filesystemType: cgroup2 },
    process(pid: number, session: number, startTimeTicks: string): void {
      mkdirSync(join(procRoot, String(pid)));
      writeFileSync(
        join(procRoot, String(pid), "stat"),
        statLine(pid, session, startTimeTicks),
      );
    },
    cgroup(path: string, populated: boolean | null): void {
      mkdirSync(join(cgroupRoot, path), { recursive: true });
      writeFileSync(join(cgroupRoot, path, "cgroup.procs"), "");
      if (populated !== null) {
        writeFileSync(
          join(cgroupRoot, path, "cgroup.events"),
          `populated ${populated ? 1 : 0}\nfrozen 0\n`,
        );
      }
    },
    membership(pid: number, content: string): void {
      mkdirSync(join(procRoot, String(pid)), { recursive: true });
      writeFileSync(join(procRoot, String(pid), "cgroup"), content);
    },
  };
}

const scope = "/user.slice/user-1000.slice/user@1000.service/app.slice/app-dev.inertia.app-6103.scope";
const guardian = (overrides: Record<string, unknown> = {}) => ({
  pid: 369_494,
  startTimeTicks: "49691995",
  cgroupPath: scope,
  cgroupNamespace: LINUX_INIT_CGROUP_NAMESPACE,
  ...overrides,
});

describe.skipIf(process.platform === "win32")("Linux guardian cgroup proof", () => {
  it("accepts an unpopulated or removed scope only beneath a real parent cgroup", () => {
    const host = fakeHost();
    host.cgroup(posix.dirname(scope), true);
    expect(linuxGuardianProcessTreeGone(guardian(), null, host.probe)).toBe(true);
    host.cgroup(scope, false);
    expect(linuxGuardianProcessTreeGone(guardian(), null, host.probe)).toBe(true);
    const orphaned = fakeHost();
    expect(linuxGuardianProcessTreeGone(guardian(), null, orphaned.probe)).toBe(false);
  });

  it("refuses a populated scope, a foreign namespace, or a non-cgroup2 hierarchy", () => {
    const host = fakeHost();
    host.cgroup(scope, true);
    expect(linuxGuardianProcessTreeGone(guardian(), null, host.probe)).toBe(false);
    const empty = fakeHost();
    empty.cgroup(scope, false);
    expect(linuxGuardianProcessTreeGone(
      guardian({ cgroupNamespace: "cgroup:[4026532000]" }),
      null,
      empty.probe,
    )).toBe(false);
    expect(linuxGuardianProcessTreeGone(
      guardian(),
      null,
      { ...empty.probe, filesystemType: () => 0x01021994 },
    )).toBe(false);
    const sandboxed = fakeHost({ namespace: "cgroup:[4026532000]" });
    sandboxed.cgroup(scope, false);
    expect(linuxGuardianProcessTreeGone(guardian(), null, sandboxed.probe)).toBe(false);
  });

  it("keeps legacy guardian claims without cgroup evidence fail-closed", () => {
    const host = fakeHost();
    host.cgroup(scope, false);
    expect(linuxGuardianProcessTreeGone(
      { pid: 369_494 },
      null,
      host.probe,
    )).toBe(false);
    expect(linuxGuardianProcessTreeGone(
      guardian({ cgroupPath: `${scope}/../other.scope` }),
      null,
      host.probe,
    )).toBe(false);
  });

  it("refuses while a process that left the scope still holds the guardian session", () => {
    const host = fakeHost();
    host.cgroup(scope, false);
    host.process(4_100, 4_100, "100");
    host.process(4_200, 369_494, "49700000");
    expect(linuxGuardianProcessTreeGone(guardian(), null, host.probe)).toBe(false);
  });

  it("ignores only the new session of a reused guardian PID", () => {
    const host = fakeHost();
    host.cgroup(scope, false);
    host.process(369_494, 369_494, "60000000");
    host.process(4_300, 369_494, "60000100");
    expect(linuxGuardianProcessTreeGone(guardian(), "60000000", host.probe)).toBe(true);
    host.process(4_400, 369_494, "59999999");
    expect(linuxGuardianProcessTreeGone(guardian(), "60000000", host.probe)).toBe(false);
  });

  it("reads one bounded unified membership line", () => {
    const host = fakeHost();
    host.membership(4_500, `0::${scope}\n`);
    expect(readLinuxProcessCgroup(4_500, host.probe)).toEqual({
      cgroupPath: scope,
      cgroupNamespace: LINUX_INIT_CGROUP_NAMESPACE,
    });
    host.membership(4_501, `1:name=systemd:${scope}\n0::${scope}\n`);
    expect(readLinuxProcessCgroup(4_501, host.probe)).toBeNull();
    host.membership(4_502, "0::/\n");
    expect(readLinuxProcessCgroup(4_502, host.probe)).toBeNull();
    host.membership(4_503, `0::${scope} (deleted)\n`);
    expect(readLinuxProcessCgroup(4_503, host.probe)).toBeNull();
    host.membership(4_504, `0::${scope}\n`);
    expect(readLinuxProcessCgroup(4_504, {
      ...host.probe,
      filesystemType: () => 0x01021994,
    })).toBeNull();
  });
});

function ownCgroup(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const membership = readFileSync("/proc/self/cgroup", "utf8").match(/^0::(\/[^\n]+)\n?$/u);
    return readlinkSync("/proc/self/ns/cgroup") === LINUX_INIT_CGROUP_NAMESPACE
      && statfsSync("/sys/fs/cgroup").type === 0x63677270
      && membership
      ? membership[1]!
      : null;
  } catch {
    return null;
  }
}

function deadLinuxProcess(): { pid: number; startTimeTicks: string } {
  const child = spawnSync("/bin/sh", ["-c", "cut -d' ' -f1,22 /proc/self/stat"], {
    encoding: "utf8",
  });
  const [pid, startTimeTicks] = child.stdout.trim().split(" ");
  if (!pid || !startTimeTicks || readLinuxProcessIdentity(Number(pid))) {
    throw new Error("Could not observe an exited process identity.");
  }
  return { pid: Number(pid), startTimeTicks };
}

function postOomDataDirectory(
  cgroupPath: string | null,
  guardianOf: () => { pid: number; startTimeTicks: string } = deadLinuxProcess,
): {
  dataDirectory: string;
  claimNames: string[];
} {
  const dataDirectory = temporaryDirectory("inertia-oom-recovery-");
  expect(new RuntimeGenerationLeaseJournal(dataDirectory)
    .publish(priorGeneration, bootId)).toBe(true);
  expect(new RuntimeOwnedProcessJournal(dataDirectory, {
    platform: "linux",
    darwinGuardianPath: guardianPath,
  }).startSession(priorGeneration, bootId)).toBe(true);
  const executable = statSync(guardianPath, { bigint: true });
  const runtimeWorker = deadLinuxProcess();
  const claimNames = Array.from({ length: 4 }, () => {
    const guardianProcess = guardianOf();
    const ownershipId = randomUUID();
    const name = `.runtime-owned-child-${ownershipId}.json`;
    writeFileSync(join(dataDirectory, name), JSON.stringify({
      version: 1,
      state: "owned",
      ownershipId,
      runtimeGenerationId: priorGeneration,
      systemBootId: bootId,
      process: {
        pid: guardianProcess.pid,
        parentPid: runtimeWorker.pid,
        processGroupId: guardianProcess.pid,
        startTimeTicks: guardianProcess.startTimeTicks,
        guardianExecutableDevice: String(executable.dev),
        guardianExecutableInode: String(executable.ino),
        ...(cgroupPath
          ? { cgroupPath, cgroupNamespace: LINUX_INIT_CGROUP_NAMESPACE }
          : {}),
      },
    }), { encoding: "utf8", mode: 0o600 });
    return name;
  });
  return { dataDirectory, claimNames };
}

function startSupervisor(dataDirectory: string) {
  const spawn = vi.fn(() => new EventEmitter() as never);
  const supervisor = new RuntimeSupervisor({
    systemBootId: bootId,
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: dataDirectory,
      enableProviders: false,
      runtimeProcessGuardianPath: guardianPath,
    },
    spawn,
  });
  supervisor.start();
  return { spawn, supervisor };
}

const currentCgroup = ownCgroup();

describe.skipIf(!currentCgroup || !existsSync(guardianPath))(
  "startup after the whole app scope was killed",
  () => {
    it("retires every artefact of a confirmed-dead generation and starts", async () => {
      const removedScope = `${dirname(currentCgroup!)}/app-dev.inertia.app-${randomUUID()}.scope`
        .replace(/^\/\//u, "/");
      const { dataDirectory, claimNames } = postOomDataDirectory(removedScope);
      const { spawn, supervisor } = startSupervisor(dataDirectory);

      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalledOnce();
      }, { timeout: 5_000 });

      expect(supervisor.snapshot().lastError).toBeNull();
      const remaining = readdirSync(dataDirectory);
      for (const name of claimNames) expect(remaining).not.toContain(name);
      expect(remaining).not.toContain(runtimeOwnedProcessWriterName(priorGeneration));
      expect(new RuntimeOwnedProcessJournal(dataDirectory)
        .sessionExact(priorGeneration)).toBeNull();
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()
        .some((lease) => lease.runtimeGenerationId === priorGeneration)).toBe(false);
    });

    it.each([
      ["a still-populated scope", () => currentCgroup],
      ["no recorded scope", () => null],
    ])("reaps marked leftovers and starts with %s", async (_label, scopeOf) => {
      const guardians: Array<{ pid: number; startTimeTicks: string }> = [];
      const { dataDirectory, claimNames } = postOomDataDirectory(scopeOf(), () => {
        const guardianProcess = deadLinuxProcess();
        guardians.push(guardianProcess);
        return guardianProcess;
      });
      const launched = spawnSync("/bin/sh", ["-c", "/bin/sleep 30 >/dev/null 2>&1 & echo $!"], {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          [LINUX_RUNTIME_OWNED_GUARDIAN_MARKER]: `${guardians[0]!.pid}:${guardians[0]!.startTimeTicks}`,
        },
      });
      const leftoverPid = Number(launched.stdout.trim());
      const leftover = readLinuxProcessIdentity(leftoverPid);
      try {
        expect(leftover).not.toBeNull();
        const { spawn, supervisor } = startSupervisor(dataDirectory);

        await vi.waitFor(() => {
          expect(spawn).toHaveBeenCalledOnce();
        }, { timeout: 5_000 });

        expect(supervisor.snapshot().lastError).toBeNull();
        expect(linuxProcessCanExecute(leftoverPid)).toBe(false);
        const remaining = readdirSync(dataDirectory);
        for (const name of claimNames) expect(remaining).not.toContain(name);
        expect(remaining).not.toContain(runtimeOwnedProcessWriterName(priorGeneration));
      } finally {
        if (leftover && readLinuxProcessIdentity(leftoverPid)?.startTimeTicks === leftover.startTimeTicks) {
          process.kill(leftoverPid, "SIGKILL");
        }
      }
    });

    it("retires a reused guardian PID without signalling its new owner", async () => {
      const holder = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
      const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
      try {
        const identity = readLinuxProcessIdentity(holder.pid!);
        if (!identity) throw new Error("Missing reused PID holder.");
        const removedScope = `${dirname(currentCgroup!)}/app-dev.inertia.app-${randomUUID()}.scope`
          .replace(/^\/\//u, "/");
        const { dataDirectory } = postOomDataDirectory(removedScope, () => ({
          pid: identity.pid,
          startTimeTicks: String(BigInt(identity.startTimeTicks) - 1n),
        }));
        const kill = vi.fn<typeof process.kill>(() => true);
        const forceKill = vi.fn(async () => true);

        await expect(recoverRuntimeOwnedProcesses(dataDirectory, priorGeneration, bootId, {
          deadlineAt: Date.now() + 2_000,
          platform: "linux",
          darwinGuardianPath: guardianPath,
          kill,
          forceKill,
        })).resolves.toBe(true);

        expect(kill).not.toHaveBeenCalled();
        expect(forceKill).not.toHaveBeenCalled();
        expect(new RuntimeOwnedProcessJournal(dataDirectory).records(priorGeneration))
          .toEqual([]);
        expect(readLinuxProcessIdentity(holder.pid!)).toEqual(identity);
      } finally {
        holder.kill("SIGKILL");
        await closed;
      }
    });

    it("records the guardian scope in each Linux ownership claim", async () => {
      const dataDirectory = temporaryDirectory("inertia-oom-claim-");
      const generation = "72000000-0000-4000-8000-000000000072:1";
      const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
        dataDirectory,
        generation,
        bootId,
        { darwinGuardianPath: guardianPath },
      );
      const invocation = runtimeOwnedProcessInvocation(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
      );
      const child = spawnRuntimeOwnedProcess(() => spawn(
        invocation.command,
        invocation.args,
        { detached: true, shell: false, stdio: "ignore" },
      ));
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      try {
        const journal = new RuntimeOwnedProcessJournal(dataDirectory);
        await vi.waitFor(() => {
          expect(journal.records(generation)?.[0]?.state).toBe("owned");
        }, { timeout: 5_000 });
        expect(journal.records(generation)?.[0]).toMatchObject({
          process: {
            pid: child.pid,
            cgroupPath: currentCgroup,
            cgroupNamespace: LINUX_INIT_CGROUP_NAMESPACE,
          },
        });
      } finally {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        await closed;
        deactivate?.();
      }
    });
  },
);
