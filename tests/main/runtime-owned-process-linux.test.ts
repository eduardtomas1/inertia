import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { expect } from "vitest";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  activateRuntimeOwnedProcessRegistry,
  runtimeOwnedProcessInvocation,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import {
  linuxGuardianTerminalAuthority,
  monitorLinuxGuardianTerminal,
} from "../../src/node/runtime-owned-process-linux";

const linuxIt = process.platform === "linux" ? it : it.skip;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.lastIndexOf(")");
    return tail < 0 || stat.slice(tail + 2, tail + 3) !== "Z";
  } catch { return false; }
}

async function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Linux guardian state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("Linux runtime process guardian", () => {
  it("bounds the clean-marker hardening transition before release", () => {
    vi.useFakeTimers();
    const terminalAuthority = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const onTerminal = vi.fn(() => true);
    const onFailure = vi.fn();
    const release = vi.fn(() => true);
    monitorLinuxGuardianTerminal({
      pid: 123, parentPid: 1, processGroupId: 123, startTimeTicks: "456",
      guardianExecutableDevice: "1", guardianExecutableInode: "2",
    }, "/trusted/guardian", onTerminal, onFailure, {
      readComm: () => "inertia-done", terminalAuthority, release,
    });

    vi.advanceTimersByTime(150);
    expect(terminalAuthority).toHaveBeenCalledTimes(3);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps terminal authority on the durable identity across a helper upgrade", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-authority-")); roots.push(root);
    const oldGuardian = join(root, "guardian.old");
    const currentGuardian = join(root, "guardian.current");
    writeFileSync(oldGuardian, "old"); writeFileSync(currentGuardian, "new");
    const pid = 123; const procRoot = join(root, "proc");
    mkdirSync(join(procRoot, String(pid), "task", String(pid)), { recursive: true });
    symlinkSync(oldGuardian, join(procRoot, String(pid), "exe"));
    const fields = ["T", "1", String(pid), String(pid), ...Array.from({ length: 15 }, () => "0"), "456"];
    writeFileSync(join(procRoot, String(pid), "stat"), `${pid} (guardian) ${fields.join(" ")}\n`);
    writeFileSync(join(procRoot, String(pid), "status"), [
      "Name:\tinertia-done", "State:\tT (stopped)", "TracerPid:\t0", "Threads:\t1",
      "NoNewPrivs:\t1", "Seccomp:\t2", "Seccomp_filters:\t1", "",
    ].join("\n"));
    writeFileSync(join(procRoot, String(pid), "task", String(pid), "children"), "");
    const old = statSync(oldGuardian, { bigint: true });
    expect(linuxGuardianTerminalAuthority({
      pid, parentPid: 999, processGroupId: pid, startTimeTicks: "456",
      guardianExecutableDevice: String(old.dev), guardianExecutableInode: String(old.ino),
    }, currentGuardian, procRoot)).toBe(true);
    writeFileSync(join(procRoot, String(pid), "status"), [
      "Name:\tinertia-done", "State:\tT (stopped)", "TracerPid:\t0", "Threads:\t1",
      "NoNewPrivs:\t1", "Seccomp:\t2", "",
    ].join("\n"));
    expect(linuxGuardianTerminalAuthority({
      pid, parentPid: 999, processGroupId: pid, startTimeTicks: "456",
      guardianExecutableDevice: String(old.dev), guardianExecutableInode: String(old.ino),
    }, currentGuardian, procRoot)).toBe(true);
    expect(linuxGuardianTerminalAuthority({
      pid, parentPid: 999, processGroupId: pid, startTimeTicks: "456",
      guardianExecutableDevice: "", guardianExecutableInode: "",
    }, join(root, "deleted-current-helper"), procRoot)).toBe(false);
  });

  linuxIt("drains a double-fork setsid descendant after its runtime parent crashes", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-guardian-")); roots.push(root);
    const guardian = join(root, "guardian");
    const payload = join(root, "payload");
    const descendantPid = join(root, "descendant.pid");
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
    ]);
    execFileSync(guardian, ["seccomp-selftest"]);
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "tests/fixtures/linux-double-fork.c"), "-o", payload,
    ]);

    const harness = spawn(process.execPath, [
      join(process.cwd(), "tests/fixtures/linux-guardian-parent.cjs"),
      guardian, payload, descendantPid, join(root, "guardian.pid"),
    ], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      harness.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`harness exited ${code}`)));
    });
    await waitFor(() => {
      try { return readFileSync(descendantPid, "utf8").trim().length > 0; } catch { return false; }
    });
    const guardianPid = Number(readFileSync(join(root, "guardian.pid"), "utf8"));
    const escapedPid = Number(readFileSync(descendantPid, "utf8"));
    await waitFor(() => {
      try {
        return readFileSync(`/proc/${guardianPid}/comm`, "utf8").trim() === "inertia-done"
          && !exists(escapedPid);
      } catch { return false; }
    });
    const identity = execFileSync(guardian, ["identity", String(guardianPid)], { encoding: "utf8" }).trim().split("|");
    const executable = statSync(guardian, { bigint: true });
    execFileSync(guardian, [
      "signal", String(guardianPid), identity[3]!,
      String(executable.dev), String(executable.ino),
      String(executable.dev), String(executable.ino), "release",
    ]);
    await waitFor(() => !exists(guardianPid));
  }, 15_000);

  linuxIt("routes forced cancellation through the guardian drain", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-force-")); roots.push(root);
    const guardian = join(root, "guardian");
    const payload = join(root, "payload");
    const descendantPid = join(root, "descendant.pid");
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian]);
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "tests/fixtures/linux-double-fork.c"), "-o", payload]);
    const generation = "30000000-0000-4000-8000-000000000003:1";
    const boot = "test:40000000-0000-4000-8000-000000000004";
    const deactivate = activateRuntimeOwnedProcessRegistry(root, generation, boot, {
      platform: "linux", darwinGuardianPath: guardian,
    });
    try {
      const invocation = runtimeOwnedProcessInvocation(payload, [descendantPid, "keep-root"]);
      const child = spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args, {
        detached: true, stdio: "ignore",
      }));
      await waitFor(() => {
        try { return exists(Number(readFileSync(descendantPid, "utf8").trim())); } catch { return false; }
      });
      const escapedPid = Number(readFileSync(descendantPid, "utf8").trim());
      await expect(terminateProcessTreeAndWait(child, true, {
        platform: "linux", waitMs: 3_000,
      })).resolves.toBe(true);
      expect(exists(escapedPid)).toBe(false);
      expect(new RuntimeOwnedProcessJournal(root, {
        platform: "linux", darwinGuardianPath: guardian,
      }).records(generation)).toEqual([]);
    } finally {
      deactivate?.();
    }
  }, 15_000);

  linuxIt("enforces the exact preauth, claim, owned, and terminal protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-linux-protocol-")); roots.push(root);
    const guardian = join(root, "guardian");
    execFileSync("cc", [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "native/runtime-process-guardian/linux.c"), "-o", guardian,
    ]);
    const executable = statSync(guardian, { bigint: true });
    const child = spawn(guardian, [
      "watch", String(process.pid), String(executable.dev), String(executable.ino), "--", "/bin/sleep", "1",
    ], {
      detached: true, stdio: "ignore",
    });
    const pid = child.pid!;
    const ready = execFileSync(guardian, ["ready", String(pid)], { encoding: "utf8" }).trim().split("|");
    const common = [
      "signal", String(pid), ready[3]!,
      String(executable.dev), String(executable.ino),
      String(executable.dev), String(executable.ino),
    ];
    expect(() => execFileSync(guardian, [...common, "exec"])).toThrow();
    const nested = [
      "const {spawnSync}=require('node:child_process');",
      `const r=spawnSync(${JSON.stringify(guardian)},${JSON.stringify([...common, "claim"])});`,
      "process.exit(r.status ?? 99);",
    ].join("");
    expect(() => execFileSync(process.execPath, ["-e", nested])).toThrow();
    expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("inertia-ready");
    execFileSync(guardian, [...common, "claim"]);
    expect(readFileSync(`/proc/${pid}/comm`, "utf8").trim()).toBe("inertia-claim");
    expect(() => execFileSync(guardian, [...common, "claim"])).toThrow();
    execFileSync(guardian, [...common, "exec"]);
    expect(() => execFileSync(guardian, [...common, "exec"])).toThrow();
    await waitFor(() => {
      try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "inertia-done"; } catch { return false; }
    });
    execFileSync(guardian, [...common, "release"]);
    await waitFor(() => !exists(pid));
  }, 15_000);
});
