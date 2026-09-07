import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { readPublicTarget, verifyPrivateDownloadedTarget } from "./linux-public-update-evidence.mjs";

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Native Linux x64 required.");
const image = resolve(process.argv[2]);
const root = resolve(process.argv[3]);
assert.equal(process.argv.length, 6);
assert.equal(process.argv[4], "0.0.54");
assert.match(process.argv[5], /^[a-f0-9]{64}$/u);
const expectedDigest = "81621b079ed09b820e1dc7e33d496394223c8235ef6d209c623acd44846fe8b2";
const report = { schemaVersion: 1, publicPredecessor: "v0.0.53", sha256: expectedDigest,
  fixtureOverrides: false, phase: "binary", passed: false, cdpConnected: false };
let child;
let browser;
let page;
let endpoint;
let childOutcome;
let tail = "";
const started = performance.now();
const deadline = started + 120_000;
const remaining = () => Math.max(1, deadline - performance.now());
const wait = async (read, durationMs = 30_000) => {
  const end = Math.min(deadline, performance.now() + durationMs);
  while (performance.now() < end) {
    const value = await read();
    if (value) return value;
    if (childOutcome) throw new Error("owned-app-exited");
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error("bounded-stage-expired");
};
try {
  const metadata = await lstat(image);
  assert(metadata.isFile() && !metadata.isSymbolicLink());
  assert.equal(metadata.size, 360582286);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(image)) hash.update(chunk);
  assert.equal(hash.digest("hex"), expectedDigest);
  report.phase = "public-target";
  const target = await readPublicTarget(process.argv[5]);
  report.publicTarget = target;
  for (const name of ["home", "config", "cache", "data", "workspace", "temp"]) {
    await mkdir(join(root, name), { mode: 0o700 });
  }
  // Deliberately no inherited provider or GitHub credentials, NODE_ENV test,
  // fake update version, release proxy, or installed-update hook.
  const env = { PATH: "/usr/bin:/bin", HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    INERTIA_DATA_DIR: join(root, "data"), INERTIA_WORKSPACE_DIR: join(root, "workspace"),
    TMPDIR: join(root, "temp"), APPIMAGE_EXTRACT_AND_RUN: "1", LANG: "C.UTF-8",
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) };
  report.phase = "launch";
  child = spawn(image, ["--no-sandbox", "--remote-debugging-port=0"], {
    shell: false, detached: true, env, stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("exit", (code, signal) => { childOutcome = { code, signal }; });
  child.once("error", () => { childOutcome = { spawnError: true }; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    tail = (tail + chunk.toString("utf8")).slice(-4096);
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:[1-9][0-9]*\/devtools\/browser\/[a-zA-Z0-9-]+)/u.exec(tail);
    if (match) endpoint = match[1];
  });
  report.phase = "renderer-cdp";
  await wait(() => endpoint);
  browser = await chromium.connectOverCDP(endpoint, { timeout: Math.min(30_000, remaining()) });
  report.cdpConnected = true;
  page = await wait(async () => {
    for (const context of browser.contexts()) for (const candidate of context.pages()) {
      if (await candidate.evaluate(() => typeof window.inertia?.checkAppUpdate === "function").catch(() => false)) return candidate;
    }
    return null;
  });
  report.phase = "workbench";
  await page.locator(".app-shell:not(.offline)").waitFor({ state: "visible", timeout: Math.min(30_000, remaining()) });
  report.phase = "real-update-check";
  const status = await Promise.race([
    page.evaluate(() => window.inertia.checkAppUpdate(true)),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("check-deadline")), Math.min(30_000, remaining())); timer.unref(); }),
  ]);
  // Persist only fixed public status fields, never messages, endpoint URLs,
  // profile contents, arbitrary child output, or provider details.
  assert.equal(status.currentVersion, "0.0.53");
  assert.equal(status.latestVersion, "0.0.54");
  assert.equal(status.channel, "stable");
  assert.equal(status.delivery, "in-app");
  assert.equal(status.state, "available");
  assert.equal(status.installBlocker, null);
  assert.equal(status.freshness, "fresh");
  report.status = { currentVersion: "0.0.53", latestVersion: "0.0.54", channel: "stable",
    delivery: "in-app", state: "available", installBlocker: null, freshness: "fresh" };
  report.phase = "real-public-download";
  const downloaded = await Promise.race([
    page.evaluate(() => window.inertia.downloadAppUpdate()),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("download-deadline")), remaining()); timer.unref(); }),
  ]);
  assert.equal(downloaded.currentVersion, "0.0.53");
  assert.equal(downloaded.latestVersion, "0.0.54");
  assert.equal(downloaded.state, "downloaded");
  assert.equal(downloaded.installBlocker, null);
  report.phase = "private-cache-checksum";
  report.download = await verifyPrivateDownloadedTarget(root, target);
  report.download.state = "downloaded";
  report.installInvoked = false;
  report.phase = "normal-close";
  await page.close({ runBeforeUnload: true });
  await wait(() => childOutcome, 15_000);
  assert.equal(childOutcome.code, 0);
  assert.equal(childOutcome.signal, null);
  report.passed = true;
  report.phase = "complete";
} catch {
  process.exitCode = 1;
} finally {
  report.elapsedMs = Math.round(performance.now() - started);
  if (childOutcome) report.launcherExit = childOutcome;
  await page?.close({ runBeforeUnload: true }).catch(() => {});
  await browser?.close().catch(() => {});
  child?.stdout.destroy();
  child?.stderr.destroy();
  child?.unref();
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report));
}
