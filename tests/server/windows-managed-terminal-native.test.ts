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
  const startedAt = performance.now();
  let readyAtMs: number | null = null;
  let exitAtMs: number | null = null;
  let watcherClosedAtMs: number | null = null;
  let stopAtMs: number | null = null;
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
      watcher.stdout?.on("data", (data: Buffer) => { watcherOutput = (watcherOutput + data.toString()).slice(0, 1024);
        if (readyAtMs === null && watcherOutput.startsWith("INERTIA_TERMINAL_JOB_READY\n")) readyAtMs = Math.round(performance.now() - startedAt); });
      watcher.stderr?.on("data", (data: Buffer) => { watcherError = (watcherError + data.toString()).slice(0, 1024); });
      watcher.on("close", (code, signal) => { watcherCode = code; watcherSignal = signal; watcherClosedAtMs = Math.round(performance.now() - startedAt); });
      return watcher;
    }) as typeof spawnChild,
  });
  const requestStop = owned.requestGuardianStop;
  owned.requestGuardianStop = () => {
    stopAtMs ??= Math.round(performance.now() - startedAt);
    return requestStop();
  };
  owned.process.onData((data) => { output = (output + data).slice(-8192); });
  owned.process.onExit(({ exitCode }) => { exit = exitCode; exitAtMs = Math.round(performance.now() - startedAt); });
  observations.push(() => ({
    guardianExitCode: exit, watcherCode, watcherSignal,
    readyAtMs, exitAtMs, watcherClosedAtMs, stopAtMs,
    // This exact no-profile, secret-free fixture contains only a constant script.
    fallbackFixtureOutput: command === "powershell.exe"
      ? output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").slice(0, 2048) : undefined,
    clock: [...watcherError.matchAll(/INERTIA_TERMINAL_CLOCK before_us=(\d+) after_us=(\d+)/gu)]
      .map((match) => ({ beforeUs: Number(match[1]), afterUs: Number(match[2]) })),
    watcherReady: watcherOutput.startsWith("INERTIA_TERMINAL_JOB_READY\n"),
    watcherStopped: watcherOutput === "INERTIA_TERMINAL_JOB_READY\nINERTIA_TERMINAL_JOB_STOPPED\n",
    watcherOutputBytes: Buffer.byteLength(watcherOutput),
    nativeStages: [output, watcherError].flatMap((text) => [...text.matchAll(
      /INERTIA_JOB_ERROR stage=(terminal-(?:launch-arguments|launch-times|launch|job-create|job-assign|admission-exists|console-handles|console-attribute-size|console-attributes|console-inheritance|console-create|watch-identity|watch-times|watch-birth-before|watch-birth-after|watch-root-parent|watch-watcher-parent|watch-image|watch-membership|watch-terminate|watch-drain|watch-root-wait|watch)) win32=(\d+)/gu,
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
    // Cold ARM64 helper-path startup took 8.212s in run 34727886221; see the
    // open observation in docs/ISSUE_356_TRIAGE.md. This new fixture allowance
    // does not change the native 3s admission or 2s complete-Job Stop deadlines.
    await expect.poll(action.output, { timeout: process.arch === "arm64" ? 15000 : 4000 }).toContain("FALLBACK_READY");
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

  it("distinguishes one native birth tick for the same PID in its exact namespace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-terminal-identity-"));
    directories.push(directory);
    const executable = join(directory, "identity-proof.exe");
    const compiler = ["Framework64", "Framework"].map((framework) => join(
      process.env.SystemRoot ?? process.env.SYSTEMROOT!, "Microsoft.NET", framework, "v4.0.30319", "csc.exe",
    )).find((path) => existsSync(path));
    expect(compiler).toBeDefined();
    const compilation = launched("", undefined, compiler!, ["/nologo", "/target:exe", "/platform:anycpu",
      `/out:${executable}`, resolve("tests/fixtures/windows-managed-terminal/identity.cs")]);
    await expect.poll(compilation.exit, { timeout: 10000 }).toBe(0);
    expect(await compilation.owned.waitForGuardianStop()).toBe(true);
    const proof = launched("", undefined, executable, [testWindowsTerminalAuthority()!.path]);
    await expect.poll(proof.output, { timeout: 4000 }).toContain("NATIVE_IDENTITY_DISTINCT");
    await expect.poll(proof.exit, { timeout: 4000 }).toBe(7);
    expect(await proof.owned.waitForGuardianStop()).toBe(true);
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

  it("rejects a replacement root's native namespace without admitting payload or touching its sibling", async () => {
    const sibling = launched(leaf);
    await expect.poll(sibling.output, { timeout: 4000 }).toContain("ACTION_READY");
    const directory = mkdtempSync(join(tmpdir(), "inertia-terminal-admission-"));
    directories.push(directory);
    const marker = join(directory, "payload-started");
    const action = launched(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');`, (args) => {
      // A real same-image, same-parent root has a different native tuple. Its
      // retained handle must not open this new action's Job or admission event.
      args[2] = String(sibling.owned.process.pid);
    });
    expect(await action.owned.waitForGuardianStop()).toBe(false);
    // Native admission is bounded to 3s. ConPTY separately buffers its final
    // output for about 1s before node-pty delivers onExit; prove process death
    // within the original bound, then let afterEach drain the callback.
    await expect.poll(() => alive(action.owned.process.pid), { timeout: 4000 }).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(action.owned.confirmStopped()).toBe(false);
    expect(alive(sibling.owned.process.pid)).toBe(true);
    expect(sibling.exit()).toBeNull();
    sibling.owned.requestGuardianStop();
    expect(await sibling.owned.waitForGuardianStop()).toBe(true);
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
    await expect.poll(() => alive(terminal.pid), { timeout: 4000 }).toBe(false);
    expect(alive(terminal.pid)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    await expect.poll(() => exited, { timeout: 2000 }).toBe(true);
  });
});
