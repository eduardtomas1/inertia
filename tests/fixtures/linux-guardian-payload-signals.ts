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
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "inertia-linux-payload-signals-"));
  const executable = join(root, "guardian");
  let child: ChildProcess | undefined;
  try {
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "native/runtime-process-guardian/linux.c", "-o", executable], { timeout: 10_000 });
    const metadata = statSync(executable, { bigint: true });
    child = spawn(executable, ["watch", String(process.pid), String(metadata.dev),
      String(metadata.ino), "--", ...payload(root)], { detached: true, stdio: "ignore" });
    const ready = execFileSync(executable, ["ready", String(child.pid)], {
      encoding: "utf8", timeout: 5_000,
    }).trim().split("|");
    const command = (action: string) => {
      execFileSync(executable, ["signal", String(child!.pid), ready[3]!,
        String(metadata.dev), String(metadata.ino), action], { timeout: 5_000 });
    };
    const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim();
    assert.equal(children.split(/\s+/u).length, 1);
    const payloadPid = Number(children);
    const payloadStat = readFileSync(`/proc/${payloadPid}/stat`, "utf8");
    const payloadStart = payloadStat.slice(payloadStat.lastIndexOf(")") + 2).split(" ")[19];
    try { await check({ child, payloadPid, root, command }); }
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

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"] as const) {
  void linuxIt(`restores ${signal} for the payload while it waits for authorization`, async () => {
    await withGuardian((root) => ["/usr/bin/touch", join(root, "executed")], async (fixture) => {
      process.kill(fixture.payloadPid, signal);
      await waitFor(() => processState(fixture.payloadPid) === "Z");
      assert.equal(existsSync(join(fixture.root, "executed")), false);
      fixture.child.kill("SIGTERM");
      await stopped(fixture.child);
      assert.equal(fixture.child.exitCode, 143);
      assert.equal(processState(fixture.payloadPid), null);
    });
  });
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
