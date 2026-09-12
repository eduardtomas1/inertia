import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userShell } from "../../src/server/terminal-invocation";

import { spawnWindowsManagedTerminal } from "../../src/server/windows-managed-terminal";
import { testWindowsTerminalAuthority } from "../support/windows-terminal-authority";

const pending: Array<() => Promise<void>> = [];
const directories: string[] = [];
const observations: Array<() => object> = [];


afterEach(async (context) => {
  try {
    vi.unstubAllEnvs();
    for (const cleanup of pending.splice(0).reverse()) await cleanup();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  } finally {
    const receipts = observations.splice(0).map((observe) => observe());
    mkdirSync("test-results", { recursive: true });
    appendFileSync("test-results/windows-managed-job-diagnostics.jsonl", `${JSON.stringify({
      case: context.task.name, observations: receipts,
    })}\n`);
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function launched(script: string, mutateWatcher?: (args: string[]) => void, command = process.execPath, args = ["-e", script]) {
  let output = "";
  let exit: number | null = null;
  let watcher!: ChildProcess;
  let watcherCode: number | null = null;
  let watcherSignal: string | null = null;
  let watcherOutput = "";
  let watcherError = "";
  const owned = spawnWindowsManagedTerminal({
    authority: testWindowsTerminalAuthority(), command, args,
    spawnOwned: (create) => ({ process: create(), confirmStopped: () => true,
      releaseIfGroupExited: () => undefined, requestGuardianStop: () => false,
      waitForGuardianStop: async () => false }),
    spawnTerminal: (command, args) => spawn(command, args, {
      name: "xterm-256color", cols: 100, rows: 24, cwd: process.cwd(), env: process.env,
    }),
    spawnWatcher: ((command: string, args: string[], options: object) => {
      mutateWatcher?.(args);
      watcher = spawnChild(command, args, options);
      watcher.stdout?.on("data", (data: Buffer) => { watcherOutput = (watcherOutput + data.toString()).slice(0, 1024); });
      watcher.stderr?.on("data", (data: Buffer) => { watcherError = (watcherError + data.toString()).slice(0, 1024); });
      watcher.on("close", (code, signal) => { watcherCode = code; watcherSignal = signal; });
      return watcher;
    }) as typeof spawnChild,
  });
  owned.process.onData((data) => { output = (output + data).slice(-8192); });
  owned.process.onExit(({ exitCode }) => { exit = exitCode; });
  observations.push(() => ({
    guardianExitCode: exit, watcherCode, watcherSignal,
    watcherReady: watcherOutput.startsWith("INERTIA_TERMINAL_JOB_READY\n"),
    watcherStopped: watcherOutput === "INERTIA_TERMINAL_JOB_READY\nINERTIA_TERMINAL_JOB_STOPPED\n",
    watcherOutputBytes: Buffer.byteLength(watcherOutput),
    nativeStages: [output, watcherError].flatMap((text) => [...text.matchAll(
      /INERTIA_JOB_ERROR stage=(terminal-(?:launch-arguments|launch|job-create|job-assign|admission-exists|console-handles|console-attribute-size|console-attributes|console-inheritance|console-create|watch-identity|watch-membership|watch)) win32=(\d+)/gu,
    )].map((match) => ({ stage: match[1], win32: Number(match[2]) }))),
  }));
  pending.push(async () => {
    owned.requestGuardianStop();
    await expect.poll(() => exit !== null, { timeout: 4000 }).toBe(true);
    expect(alive(owned.process.pid)).toBe(false);
  });
  return { owned, watcher, output: () => output, exit: () => exit };
}

const leaf = 'process.stdout.write("ACTION_READY\\n"); setInterval(() => {}, 1000)';

describe.runIf(process.platform === "win32")("native managed Windows terminal Job", () => {
  it("preserves ConPTY input, output and the exact normal payload exit code", async () => {
    const action = launched('process.stdout.write("ACTION_READY\\n"); process.stdin.once("data", () => { process.stdout.write("INPUT_RECEIVED\\n", () => process.exit(7)); })');
    await expect.poll(action.output, { timeout: 4000 }).toContain("ACTION_READY");
    action.owned.process.write("hello\r");
    await expect.poll(action.output, { timeout: 4000 }).toContain("INPUT_RECEIVED");
    await expect.poll(action.exit, { timeout: 4000 }).toBe(7);
    expect(await action.owned.waitForGuardianStop()).toBe(true);
    expect(action.owned.confirmStopped()).toBe(true);
  });

  it("preserves the ComSpec-unset basename shell fallback", async () => {
    vi.stubEnv("ComSpec", undefined);
    const command = userShell("win32").executable;
    expect(command).toBe("powershell.exe");
    const action = launched("", undefined, command, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('FALLBACK_READY'); exit 7"]);
    await expect.poll(action.output, { timeout: 4000 }).toContain("FALLBACK_READY");
    await expect.poll(action.exit, { timeout: 4000 }).toBe(7);
    expect(await action.owned.waitForGuardianStop()).toBe(true);
  });

  it("stops before admission without executing any payload or using PID fallback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-terminal-early-stop-"));
    directories.push(directory);
    const marker = join(directory, "payload-started");
    const action = launched(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');`);
    action.owned.requestGuardianStop();
    expect(await action.owned.waitForGuardianStop()).toBe(true);
    await expect.poll(() => action.exit() !== null, { timeout: 3000 }).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("contains reparented grandchildren after their transient parent has exited", async () => {
    const grandchild = 'setInterval(() => {}, 1000)';
    const transient = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'}); process.stdout.write('GRANDCHILD='+c.pid+'\\n',()=>process.exit(0));`;
    const action = launched(`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(transient)}],{stdio:['ignore','inherit','inherit']}).on('exit',()=>process.stdout.write('TRANSIENT_EXITED\\n')); setInterval(()=>{},1000);`);
    await expect.poll(action.output, { timeout: 4000 }).toContain("TRANSIENT_EXITED");
    const grandchildPid = Number(/GRANDCHILD=(\d+)/u.exec(action.output())?.[1]);
    expect(grandchildPid).toBeGreaterThan(1);
    expect(alive(grandchildPid)).toBe(true);
    action.owned.requestGuardianStop();
    expect(await action.owned.waitForGuardianStop()).toBe(true);
    await expect.poll(() => alive(grandchildPid), { timeout: 3000 }).toBe(false);
  });

  it("drains background descendants on natural root exit and preserves a sibling terminal", async () => {
    const sibling = launched(leaf);
    await expect.poll(sibling.output, { timeout: 4000 }).toContain("ACTION_READY");
    const action = launched("const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); process.stdout.write('BACKGROUND='+c.pid+'\\n',()=>process.exit(0));");
    await expect.poll(action.exit, { timeout: 4000 }).toBe(0);
    const childPid = Number(/BACKGROUND=(\d+)/u.exec(action.output())?.[1]);
    expect(childPid).toBeGreaterThan(1);
    expect(await action.owned.waitForGuardianStop()).toBe(true);
    expect(alive(childPid)).toBe(false);
    expect(alive(sibling.owned.process.pid)).toBe(true);
    expect(sibling.exit()).toBeNull();
    sibling.owned.requestGuardianStop();
    expect(await sibling.owned.waitForGuardianStop()).toBe(true);
  });

  it("kills the admitted Job when the watcher crashes without accepting missing proof", async () => {
    const action = launched(leaf);
    await expect.poll(action.output, { timeout: 4000 }).toContain("ACTION_READY");
    // ChildProcess retains the exact spawned watcher handle on Windows.
    action.watcher.kill();
    expect(await action.owned.waitForGuardianStop()).toBe(false);
    await expect.poll(() => alive(action.owned.process.pid), { timeout: 3000 }).toBe(false);
    expect(action.owned.confirmStopped()).toBe(false);
  });

  it("drains an admitted descendant after the runtime owner dies, preserving an unrelated sibling", async () => {
    const sibling = launched(leaf);
    await expect.poll(sibling.output, { timeout: 4000 }).toContain("ACTION_READY");
    const authority = testWindowsTerminalAuthority()!;
    const owner = spawnChild(process.execPath, [
      resolve("tests/fixtures/windows-managed-terminal/owner.cjs"), authority.path, authority.sha256,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let ownerClosed = false;
    owner.stdout.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-4096); });
    owner.stderr.resume();
    owner.on("close", () => { ownerClosed = true; });
    pending.push(async () => {
      if (!ownerClosed) owner.kill();
      await expect.poll(() => ownerClosed, { timeout: 3000 }).toBe(true);
    });
    await expect.poll(() => output.endsWith("\n"), { timeout: 5000 }).toBe(true);
    const identities = JSON.parse(output) as { guardian: number; watcher: number; descendant: number };
    for (const pid of Object.values(identities)) { expect(pid).toBeGreaterThan(1); expect(alive(pid)).toBe(true); }
    owner.kill();
    await expect.poll(() => ownerClosed, { timeout: 3000 }).toBe(true);
    for (const pid of Object.values(identities)) {
      await expect.poll(() => alive(pid), { timeout: 4000 }).toBe(false);
    }
    expect(alive(sibling.owned.process.pid)).toBe(true);
    expect(sibling.exit()).toBeNull();
    sibling.owned.requestGuardianStop();
    expect(await sibling.owned.waitForGuardianStop()).toBe(true);
  });

  it("rejects a mismatched creation identity before any user action can execute", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-terminal-admission-"));
    directories.push(directory);
    const marker = join(directory, "payload-started");
    const action = launched(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');`, (args) => {
      args[4] = "1"; args[5] = "2";
    });
    expect(await action.owned.waitForGuardianStop()).toBe(false);
    await expect.poll(() => action.exit() !== null, { timeout: 4000 }).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(action.owned.confirmStopped()).toBe(false);
  });

  it("keeps a missing-watcher's gate closed until its bounded self-cleanup", async () => {
    const authority = testWindowsTerminalAuthority()!;
    const directory = mkdtempSync(join(tmpdir(), "inertia-terminal-no-watch-"));
    directories.push(directory);
    const marker = join(directory, "payload-started");
    const terminal: IPty = spawn(authority.path, ["terminal-launch", randomUUID(), process.execPath,
      `-e "require('fs').writeFileSync('${marker.replaceAll("\\", "\\\\")}', 'started')"`, authority.sha256],
    { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    let exited = false;
    terminal.onExit(() => { exited = true; });
    terminal.onData(() => undefined);
    await expect.poll(() => exited, { timeout: 4000 }).toBe(true);
    expect(alive(terminal.pid)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
