import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import WebSocket from "ws";
import { readPublicTarget, verifyPrivateDownloadedTarget, verifyTargetFile } from "./linux-public-update-evidence.mjs";
import { exactOwner, ownedWindow, processIdentity, profileDirectory, readyRuntime } from "./linux-public-upgrade-ownership.mjs";
import { runPackagedHistorySmoke, resumePackagedHistorySmoke } from "./package-smoke-history-runtime.mjs";
import { assertHistoryAfterShutdown } from "./package-smoke-history-storage.mjs";

assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(process.argv.length, 6);
assert.equal(process.argv[4], "0.0.54");
assert.match(process.argv[5], /^[a-f0-9]{64}$/u);
const predecessor = resolve(process.argv[2]), root = resolve(process.argv[3]);
const predecessorDigest = "81621b079ed09b820e1dc7e33d496394223c8235ef6d209c623acd44846fe8b2";
const report = { schemaVersion: 1, proof: "normal-public-upgrade", passed: false,
  fixtureAdvertisementAndDownload: false, fixtureVersionOverride: false, phase: "public-target" };
const started = Date.now(), deadline = started + 150_000;
const remaining = () => Math.max(1, deadline - Date.now());
const connections = [], launchers = [];
const guardian = await processIdentity(process.ppid);
assert(guardian);
const pause = () => new Promise(done => setTimeout(done, 50));
async function wait(label, read, duration = 30_000) {
  const end = Math.min(deadline, Date.now() + duration);
  do { const value = await read(); if (value) return value; await pause(); } while (Date.now() < end);
  throw new Error(`Bounded ${label} failed.`);
}
async function bounded(promise, duration = remaining()) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Bounded public operation expired.")), Math.min(duration, remaining())); })]); }
  finally { clearTimeout(timer); }
}
async function gone(identity) {
  const value = await processIdentity(identity.pid);
  return !value || value.start !== identity.start;
}
async function launch(path, env) {
  let endpoint, tail = "", exit;
  // No harness --no-sandbox argument or ELECTRON_DISABLE_SANDBOX override.
  // The untouched AppRun chooses its ordinary namespace/sandbox behavior.
  const child = spawn(path, ["--remote-debugging-port=0"], { shell: false, detached: true,
    env, stdio: ["ignore", "pipe", "pipe"] });
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  child.once("error", () => { exit = { spawnError: true }; });
  launchers.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    tail = (tail + chunk.toString("utf8")).slice(-4096);
    endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:[1-9][0-9]*\/devtools\/browser\/[a-zA-Z0-9-]+)/u.exec(tail)?.[1] ?? endpoint;
  });
  await wait("renderer endpoint", () => { assert(!exit, "Owned application exited before readiness."); return endpoint; });
  const browser = await chromium.connectOverCDP(endpoint, { timeout: Math.min(30_000, remaining()) });
  connections.push(browser);
  const page = await wait("trusted renderer", async () => {
    for (const context of browser.contexts()) for (const candidate of context.pages()) {
      if (await candidate.evaluate(() => typeof window.inertia?.installAppUpdate === "function").catch(() => false)) return candidate;
    }
    return null;
  });
  await page.locator(".app-shell:not(.offline)").waitFor({ state: "visible", timeout: Math.min(30_000, remaining()) });
  return { page, browser, exit: () => exit };
}
async function connection(page) {
  const value = await bounded(page.evaluate(() => window.inertia.getRuntimeConnection()), 10_000);
  assert(value && typeof value.websocketUrl === "string" && !value.unavailable);
  const parsed = new URL(value.websocketUrl);
  assert(parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1");
  return value.websocketUrl; // Capability stays only in process memory.
}
async function configureProvider(url, path) {
  const socket = new WebSocket(url, { headers: { Origin: "http://127.0.0.1" }, maxPayload: 1024 * 1024 });
  const requestId = randomUUID();
  try {
    await bounded(new Promise((yes, no) => {
      socket.once("error", no);
      socket.once("close", () => no(new Error("Provider configuration connection closed.")));
      socket.once("open", () => socket.send(JSON.stringify({ type: "settings.update", requestId, payload: { codexBinaryPath: path } })));
      socket.on("message", bytes => {
        try {
          const frame = JSON.parse(bytes.toString("utf8"));
          const event = frame.type === "runtime.event" ? frame.event : frame;
          if (event.requestId === requestId) {
            if (event.type === "request.error") no(new Error("Normal provider configuration rejected."));
            if (event.type === "request.ok") yes();
          }
        } catch { no(new Error("Invalid provider configuration response.")); }
      });
    }), 10_000);
  } finally { socket.close(); }
}

try {
  const target = await readPublicTarget(process.argv[5]); // Fails until immutable public54 exists.
  report.publicTarget = target;
  await verifyTargetFile(predecessor, { size: 360582286, sha256: predecessorDigest });
  report.predecessor = { version: "0.0.53", size: 360582286, sha256: predecessorDigest };
  for (const name of ["home", "config", "cache", "data", "workspace", "temp", "bin"]) await mkdir(join(root, name), { mode: 0o700 });
  const installed = join(root, "Inertia-0.0.53.AppImage"), stable = join(root, "Inertia.AppImage");
  const workspace = join(root, "workspace"), codex = join(root, "bin", "codex");
  await copyFile(predecessor, installed); await chmod(installed, 0o755);
  await copyFile(process.execPath, codex); await chmod(codex, 0o755);
  await writeFile(join(workspace, "login"), 'console.log("Logged in using ChatGPT");\n', { mode: 0o600 });
  await copyFile(new URL("./package-smoke-codex-fixture.cjs", import.meta.url), join(workspace, "app-server"));
  const env = { PATH: "/usr/bin:/bin", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"), INERTIA_DATA_DIR: join(root, "data"), INERTIA_WORKSPACE_DIR: workspace,
    TMPDIR: join(root, "temp"), APPIMAGE_EXTRACT_AND_RUN: "1", LANG: "C.UTF-8",
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) };
  const initialized = spawnSync("/usr/bin/git", ["init", "--quiet", workspace], { env, shell: false, timeout: 5000, maxBuffer: 4096 });
  assert(!initialized.error && initialized.status === 0 && initialized.signal === null);
  const namespaces = spawnSync("/usr/bin/unshare", ["-Ur", "/usr/bin/true"], { env, shell: false, timeout: 2000, stdio: "ignore" });
  report.host = { userNamespacesAvailable: !namespaces.error && namespaces.status === 0 && namespaces.signal === null,
    explicitSandboxOverride: false, extractionLaunch: true };
  report.phase = "normal-v53-launch";
  const old = await launch(installed, env);
  const profile = await profileDirectory(root);
  const oldOwner = await wait("old runtime identity", () => readyRuntime(profile, new Set(), started));
  await exactOwner(oldOwner.main, guardian); await exactOwner(oldOwner.runtime, guardian);
  await wait("old mapped window", () => ownedWindow("find", oldOwner.main, guardian, env), 5000);
  const oldUrl = await connection(old.page);
  await configureProvider(oldUrl, codex);
  report.phase = "seed-real-v53-history";
  const history = await runPackagedHistorySmoke({ websocketUrl: oldUrl, workspaceDirectory: workspace, deadlineAt: Math.min(deadline, Date.now() + 30_000) });
  const sentinel = randomUUID();
  await writeFile(join(root, "data", "user-owned-file"), sentinel, { mode: 0o600 });
  report.phase = "normal-public-check";
  const available = await bounded(old.page.evaluate(() => window.inertia.checkAppUpdate(true)), 30_000);
  for (const [key, value] of Object.entries({ currentVersion: "0.0.53", latestVersion: "0.0.54", channel: "stable", delivery: "in-app", state: "available", freshness: "fresh", installBlocker: null })) assert.equal(available[key], value);
  report.phase = "normal-public-download";
  const downloaded = await bounded(old.page.evaluate(() => window.inertia.downloadAppUpdate()));
  assert.equal(downloaded.state, "downloaded"); assert.equal(downloaded.installBlocker, null);
  assert.equal(downloaded.currentVersion, "0.0.53"); assert.equal(downloaded.latestVersion, "0.0.54");
  report.download = await verifyPrivateDownloadedTarget(root, target);
  report.phase = "normal-install-once";
  const installAt = Date.now();
  let installResult, installTransportClosed = false;
  // The old renderer can disappear before its IPC promise resolves. That alone
  // never counts as success: all native replacement conditions below must hold.
  const installing = old.page.evaluate(() => window.inertia.installAppUpdate()).then(value => { installResult = value; }, () => { installTransportClosed = true; });
  const replacement = await wait("automatic replacement readiness", async () => {
    if (installResult) assert(installResult.state !== "failed" && !installResult.installBlocker);
    const owner = await readyRuntime(profile, new Set([oldOwner.runtime.pid]), installAt);
    if (!owner || owner.main.pid === oldOwner.main.pid) return null;
    await exactOwner(owner.main, guardian); await exactOwner(owner.runtime, guardian);
    return owner;
  }, 60_000);
  await wait("old main and runtime drain", async () => await gone(oldOwner.main) && await gone(oldOwner.runtime), 15_000);
  await bounded(installing, 1000);
  report.installTransportClosed = installTransportClosed;
  report.installed = await verifyTargetFile(stable, target);
  await wait("replacement mapped window", () => ownedWindow("find", replacement.main, guardian, env), 5000);
  report.automaticReplacementReady = true;
  report.phase = "normal-replacement-close";
  await ownedWindow("close", replacement.main, guardian, env);
  await wait("replacement main and runtime drain", async () => await gone(replacement.main) && await gone(replacement.runtime), 15_000);
  await assertHistoryAfterShutdown(root, history);
  assert.equal(await readFile(join(root, "data", "user-owned-file"), "utf8"), sentinel);
  report.phase = "fresh-stable-relaunch";
  const reopened = await launch(stable, env);
  assert.equal(await profileDirectory(root), profile);
  const status = await bounded(reopened.page.evaluate(() => window.inertia.checkAppUpdate(true)), 30_000);
  assert.equal(status.currentVersion, "0.0.54"); assert.equal(status.latestVersion, "0.0.54");
  assert.equal(status.state, "current"); assert.equal(status.installBlocker, null);
  const finalHistory = await resumePackagedHistorySmoke(await connection(reopened.page), history);
  report.phase = "final-normal-close";
  await reopened.page.close({ runBeforeUnload: true });
  await wait("reopened launcher exit", () => reopened.exit(), 15_000);
  assert.deepEqual(reopened.exit(), { code: 0, signal: null });
  await assertHistoryAfterShutdown(root, finalHistory);
  await verifyTargetFile(stable, target);
  report.retainedHistoryAndSettings = true;
  report.newTurnAfterFreshRelaunch = true;
  report.phase = "complete"; report.passed = true;
} catch {
  process.exitCode = 1;
} finally {
  // Never signal or destroy a candidate window as a substitute for normal close.
  // The existing outer native guardian owns emergency cleanup and retains root.
  for (const browser of connections) await browser.close().catch(() => {});
  for (const child of launchers) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  report.elapsedMs = Date.now() - started;
  await writeFile(join(root, "report.json"), JSON.stringify(report) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
}
