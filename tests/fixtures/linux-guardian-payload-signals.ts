import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { it } from "node:test";

const linuxIt = process.platform === "linux" ? it : it.skip;

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the test guardian.");
    await delay(10);
  }
}

function processState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? null;
  } catch { return null; }
}

async function stopped(child: ChildProcess): Promise<void> {
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
}

async function withGuardian(
  payload: (root: string) => string[],
  check: (fixture: {
    child: ChildProcess; payloadPid: number; root: string; command: (action: string) => void;
    commandAsync: (action: string) => Promise<number | null>;
  }) => Promise<void>,
  inheritBlockedSignals = false,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "inertia-linux-payload-signals-"));
  const executable = join(root, "guardian");
  let child: ChildProcess | undefined;
  try {
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "native/runtime-process-guardian/linux.c", "-o", executable], { timeout: 10_000 });
    const metadata = statSync(executable, { bigint: true });
    const args = ["watch", String(process.pid), String(metadata.dev),
      String(metadata.ino), "--", ...payload(root)];
    let launcher = executable;
    if (inheritBlockedSignals) {
      launcher = join(root, "blocked-signals");
      execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        "tests/fixtures/linux-blocked-signals.c", "-o", launcher], { timeout: 10_000 });
      args.unshift(executable);
    }
    child = spawn(launcher, args, { detached: true, stdio: "ignore" });
    const ready = execFileSync(executable, ["ready", String(child.pid)], {
      encoding: "utf8", timeout: 5_000,
    }).trim().split("|");
    const command = (action: string) => {
      execFileSync(executable, ["signal", String(child!.pid), ready[3]!,
        String(metadata.dev), String(metadata.ino), action], { timeout: 5_000 });
    };
    const commandAsync = (action: string) => new Promise<number | null>((resolve) => {
      spawn(executable, ["signal", String(child!.pid), ready[3]!,
        String(metadata.dev), String(metadata.ino), action], { stdio: "ignore" })
        .once("close", (code) => resolve(code));
    });
    const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim();
    assert.equal(children.split(/\s+/u).length, 1);
    const payloadPid = Number(children);
    const payloadStat = readFileSync(`/proc/${payloadPid}/stat`, "utf8");
    const payloadStart = payloadStat.slice(payloadStat.lastIndexOf(")") + 2).split(" ")[19];
    try { await check({ child, payloadPid, root, command, commandAsync }); }
    finally {
      // Preserve the recorded birth identity when cleaning up a failed proof.
      try {
        const current = readFileSync(`/proc/${payloadPid}/stat`, "utf8");
        if (current.slice(current.lastIndexOf(")") + 2).split(" ")[19] === payloadStart) {
          process.kill(payloadPid, "SIGKILL");
        }
      } catch { /* The exact child has already exited. */ }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await delay(100);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await stopped(child);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await stopped(child);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

void linuxIt("admits, executes, and releases a guardian with inherited blocked control signals", async () => {
  await withGuardian((root) => ["/usr/bin/touch", join(root, "executed")], async ({
    child, payloadPid, root, command,
  }) => {
    assert.equal(existsSync(join(root, "executed")), false);
    command("claim");
    assert.equal(existsSync(join(root, "executed")), false);
    for (const pid of [child.pid, payloadPid]) {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const mask = BigInt(`0x${status.match(/^SigBlk:\s*([0-9a-f]+)$/mu)![1]}`);
      // Keep unrelated SIGWINCH blocked while making lifecycle signals usable.
      assert.equal(mask & 0x08000000n, 0x08000000n);
      assert.equal(mask & 0x4a07n, 0n);
    }
    command("exec");
    await waitFor(() => readFileSync(`/proc/${child.pid}/comm`, "utf8").trim() === "inertia-exdone");
    command("release");
    await stopped(child);
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
    assert.equal(existsSync(join(root, "executed")), true);
    assert.equal(processState(payloadPid), null);
  }, true);
});

for (const inheritBlockedSignals of [false, true]) {
  for (const signal of ["SIGTERM", "SIGUSR1"] as const) {
    void linuxIt(`restores ${signal} for the gated payload (inherited blocking: ${inheritBlockedSignals})`, async () => {
      await withGuardian((root) => ["/usr/bin/touch", join(root, "executed")], async (fixture) => {
        process.kill(fixture.payloadPid, signal);
        await waitFor(() => processState(fixture.payloadPid) === "Z");
        assert.equal(existsSync(join(fixture.root, "executed")), false);
        fixture.child.kill("SIGTERM");
        await stopped(fixture.child);
        assert.equal(fixture.child.exitCode, 143);
        assert.equal(processState(fixture.payloadPid), null);
      }, inheritBlockedSignals);
    });
  }
}

for (const missing of [true, false]) {
  void linuxIt(`reports ${missing ? 127 : 126} when the executable is ${missing ? "missing" : "not executable"}`, async () => {
    await withGuardian((root) => {
      const target = join(root, "payload");
      if (!missing) { writeFileSync(target, "inert fixture"); chmodSync(target, 0o600); }
      return [target];
    }, async ({ child, command }) => {
      command("claim"); command("exec");
      await waitFor(() => readFileSync(`/proc/${child.pid}/comm`, "utf8").trim() === "inertia-exdone");
      command("release");
      await stopped(child);
      assert.equal(child.exitCode, missing ? 127 : 126);
      assert.equal(child.signalCode, null);
    });
  });
}

void linuxIt("cleans up a payload killed at the gate without losing the guardian to SIGPIPE", async () => {
  await withGuardian((root) => ["/usr/bin/touch", join(root, "executed")], async ({ child, payloadPid, root, command }) => {
    process.kill(payloadPid, "SIGKILL");
    await waitFor(() => processState(payloadPid) === "Z");
    command("claim"); command("exec");
    await waitFor(() => readFileSync(`/proc/${child.pid}/comm`, "utf8").trim() === "inertia-exdone");
    command("release");
    await stopped(child);
    assert.equal(child.exitCode, 127);
    assert.equal(child.signalCode, null);
    assert.equal(existsSync(join(root, "executed")), false);
    assert.equal(processState(payloadPid), null);
  });
});

void linuxIt("retires a fast-exiting payload without a fixed polling delay", async () => {
  const elapsed: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    await withGuardian(() => ["/bin/true"], async ({ child, command, commandAsync }) => {
      command("claim");
      const comm = () => readFileSync(`/proc/${child.pid}/comm`, "utf8").trim();
      const executed = commandAsync("exec");
      let owned = 0;
      for (;;) {
        const name = comm();
        const now = performance.now();
        if (!owned && (name === "inertia-owned" || name === "inertia-exdone")) owned = now;
        if (name === "inertia-exdone") { elapsed.push(now - owned); break; }
        if (owned && now - owned > 3_000) throw new Error("Timed out waiting for the payload exit.");
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(await executed, 0);
      command("release");
      await stopped(child);
      assert.equal(child.exitCode, 0);
      assert.equal(child.signalCode, null);
    });
  }
  assert.ok(Math.min(...elapsed) < 10, `fastest retirement took ${Math.min(...elapsed)} ms`);
});

for (const prefix of ["", "trap '' TERM; "]) {
  void linuxIt(`drains a descendant that outlives its completed payload (${prefix ? "ignores" : "accepts"} TERM)`, async () => {
    await withGuardian((root) => ["/bin/sh", "-c",
      `${prefix}/bin/sleep 30 & echo $! > "$1"; exit 3`, "payload", join(root, "descendant.pid")],
    async ({ child, root, command }) => {
      command("claim"); command("exec");
      await waitFor(() => readFileSync(`/proc/${child.pid}/comm`, "utf8").trim() === "inertia-exdone");
      const descendantPid = Number(readFileSync(join(root, "descendant.pid"), "utf8").trim());
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
      assert.equal(processState(descendantPid), null);
      command("release");
      await stopped(child);
      assert.equal(child.exitCode, 3);
      assert.equal(child.signalCode, null);
    });
  });
}
