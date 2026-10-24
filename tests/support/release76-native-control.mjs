// Diagnostic branch only. Compare the native engine with and without an
// attached Playwright client; a passing control does not certify Inertia.
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const phase = process.argv[2];
if (process.platform !== "darwin" || !/^[a-z-]{1,40}$/u.test(phase ?? "")) {
  throw new Error("This control requires macOS and a bounded observation phase.");
}
const require = createRequire(import.meta.url);
const { _electron } = require("@playwright/test");
const executablePath = require("electron");
const fixture = join(dirname(fileURLToPath(import.meta.url)), "release76-native-control-main.cjs");
const environment = Object.fromEntries(["HOME", "TMPDIR", "PATH", "LANG", "LC_ALL"]
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
environment.NODE_ENV = "test";
const records = [];
let next = 0, stopped = false;
const output = resolve("test-results", "native-control", `${phase}.json`);
await mkdir(dirname(output), { recursive: true });
let saveQueue = Promise.resolve();
const save = () => saveQueue = saveQueue.then(async () => await writeFile(output, JSON.stringify({ phase,
  candidateHead: "d0c4e2ceb38fdcc86c7cb10475d54e44e61f9f4c", electron: require("electron/package.json").version,
  workers: 2, repetitionsPerMode: 30, exitDeadlineMs: 15_000, retries: 0, records,
}, null, 2)));

async function run(index) {
  const mode = index % 2 ? "playwright" : "direct";
  const profile = await mkdtemp(join(tmpdir(), "inertia-native-control-"));
  const record = { index, mode, stages: [], samples: [], outcome: "pending" };
  records.push(record);
  const started = performance.now();
  let current, child, resolveExit, resolveChildExit, resolveReady, rejectReady, timer, bootTimer;
  let tail = "";
  const sampleStops = new Set();
  const sampleTimers = new Set();
  const exited = new Promise((done) => { resolveExit = done; });
  const childExited = new Promise((done) => { resolveChildExit = done; });
  const ready = new Promise((done, reject) => { resolveReady = done; rejectReady = reject; });
  void ready.catch(() => {});
  const mark = (stage) => {
    record.stages.push({ stage, elapsedMs: Math.round(performance.now() - started) });
    if (stage === "ready") resolveReady();
  };
  const ownsMain = () => child?.pid && child.exitCode === null && child.signalCode === null;
  const sample = () => {
    if (!ownsMain()) return;
    const result = { status: "pending", output: "", truncated: false };
    record.samples.push(result);
    const tool = spawn("/usr/bin/sample", [String(child.pid), "1", "10", "-file", "/dev/stdout"], {
      shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    const chunks = []; let bytes = 0, finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true; clearTimeout(bound); sampleStops.delete(cancel);
      if (tool.pid && tool.exitCode === null && tool.signalCode === null) {
        try { process.kill(-tool.pid, "SIGKILL"); } catch { /* tool exited */ }
      }
      tool.stdout?.destroy(); tool.stderr?.destroy(); tool.unref();
      result.status = status; result.output = Buffer.concat(chunks).toString("utf8");
    };
    const cancel = () => finish("cancelled-at-main-exit-or-deadline");
    const bound = setTimeout(() => finish("sample-timeout"), 6_000);
    sampleStops.add(cancel);
    const drain = (chunk) => {
      const remaining = 128 * 1024 - bytes;
      if (chunk.length > remaining) result.truncated = true;
      if (remaining > 0) { chunks.push(Buffer.from(chunk.subarray(0, remaining))); bytes += Math.min(chunk.length, remaining); }
    };
    tool.stdout.on("data", drain); tool.stderr.on("data", drain);
    tool.once("error", () => finish("sample-unavailable"));
    tool.once("close", (code) => finish(code === 0 ? "completed" : "sample-failed"));
  };
  const armExitBound = () => {
    timer = setTimeout(() => { record.deadlineExpired = true; resolveExit(); }, 15_000);
    for (const delay of [1_000, 9_000]) {
      const pending = setTimeout(() => { sampleTimers.delete(pending); sample(); }, delay);
      sampleTimers.add(pending);
    }
  };
  const observe = (chunk) => {
    tail = (tail + chunk.toString()).slice(-2_048);
    const lines = tail.split("\n"); tail = lines.pop();
    for (const line of lines) {
      const match = /^\[NativeControl:([a-z-]+)\]$/u.exec(line);
      if (!match) continue;
      mark(match[1]);
      if (mode === "direct" && match[1] === "exit-called" && !timer) armExitBound();
    }
  };
  try {
    const args = [fixture, `--native-control-profile=${profile}`, `--native-control-mode=${mode}`];
    if (mode === "playwright") {
      current = await _electron.launch({ executablePath, args, env: environment, timeout: 30_000 });
      child = current.process();
    } else child = spawn(executablePath, args, { shell: false, detached: true,
      env: environment, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", observe);
    child.once("exit", (code, signal) => {
      record.code = code; record.signal = signal; resolveChildExit(); resolveExit();
    });
    child.once("error", () => { record.launchError = true; rejectReady(new Error("Control launch failed.")); resolveExit(); });
    if (current) {
      armExitBound();
      // As in the app fixture, the child exit is stronger evidence than the
      // inspector RPC, which can disconnect while returning its receipt.
      void current.evaluate(async () => {
        await globalThis.nativeControlReady;
        if (typeof globalThis.nativeControlQuit !== "function") throw new Error("Control unavailable.");
        globalThis.nativeControlQuit();
      }).catch(() => { record.quitRpcRejected = true; });
    } else {
      bootTimer = setTimeout(() => rejectReady(new Error("Control boot bound expired.")), 30_000);
      await ready;
    }
    await exited;
    const requestedExit = record.stages.some(({ stage }) => stage === "exit-called");
    record.outcome = !requestedExit ? "control-error" : record.deadlineExpired ? "exit-timeout"
      : record.code === 0 && record.signal === null ? "graceful" : "abnormal";
  } catch { record.outcome = "control-error"; }
  finally {
    clearTimeout(timer); clearTimeout(bootTimer);
    for (const pending of sampleTimers) clearTimeout(pending);
    for (const stop of sampleStops) stop();
    if (ownsMain()) {
      record.forced = true;
      // Both launchers create an owned process group. Verify its identity
      // before terminating the complete control tree, never an unrelated group.
      try {
        const group = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(child.pid)], {
          encoding: "utf8", timeout: 500, maxBuffer: 128, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (Number(group) === child.pid) {
          process.kill(-child.pid, "SIGKILL");
          await Promise.race([childExited, new Promise((done) => setTimeout(done, 5_000))]);
          if (ownsMain()) record.treeCleanupUnconfirmed = true;
        } else record.treeCleanupUnconfirmed = true;
      } catch { record.treeCleanupUnconfirmed = true; }
    }
    if (current) await Promise.race([current.close().catch(() => {}), new Promise((done) => setTimeout(done, 1_000))]);
    if (!ownsMain()) await rm(profile, { recursive: true, force: true, maxRetries: 0 })
      .catch(() => { record.profileRemovalFailed = true; });
    record.totalMs = Math.round(performance.now() - started);
    if (record.outcome !== "graceful" || record.profileRemovalFailed || record.treeCleanupUnconfirmed) stopped = true;
    await save();
    console.log(JSON.stringify({ phase, index, mode, outcome: record.outcome, totalMs: record.totalMs }));
  }
}
async function worker() {
  while (!stopped) { const index = next++; if (index >= 60) return; await run(index); }
}
await Promise.all([worker(), worker()]);
await save();
const counts = {};
for (const record of records) counts[`${record.mode}:${record.outcome}`] = (counts[`${record.mode}:${record.outcome}`] ?? 0) + 1;
console.log(JSON.stringify({ phase, completed: records.length, counts }));
if (stopped) process.exitCode = 1;
