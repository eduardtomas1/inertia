import { ok, equal } from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runPackagedHistorySmoke, runPackagedWorkspaceDiscovery, resumePackagedHistorySmoke } from "./package-smoke-history-runtime.mjs";
import { assertHistoryAfterShutdown } from "./package-smoke-history-storage.mjs";

if (process.platform !== "linux") throw new Error("Installed AppImage updates require native Linux.");
const source = resolve(process.argv[2]);
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const root = resolve(process.argv[3]);
await chmod(root, 0o700);
const installed = join(root, `Inertia-${version}.AppImage`);
const candidate = join(root, "downloaded.AppImage");
const workspace = join(root, "workspace");
for (const name of ["home", "config", "data", "workspace", "temp", "bin"]) {
  await mkdir(join(root, name), { mode: 0o700 });
}
await copyFile(source, installed);
await copyFile(source, candidate);
await chmod(installed, 0o755);
await chmod(candidate, 0o755);
await writeFile(join(root, "update.json"), JSON.stringify({ candidate, version }), { mode: 0o600 });
// The provider fixture is a real bounded child process, without credentials.
const codex = join(root, "bin", "codex");
await copyFile(process.execPath, codex);
await chmod(codex, 0o755);
await writeFile(join(workspace, "login"), 'console.log("Logged in using ChatGPT");\n');
await copyFile(new URL("./package-smoke-codex-fixture.cjs", import.meta.url), join(workspace, "app-server"));
execFileSync("git", ["init", "--quiet", workspace], { shell: false, timeout: 5_000, maxBuffer: 16 * 1024 });
const environment = { ...process.env, NODE_ENV: "test", HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"), INERTIA_DATA_DIR: join(root, "data"),
  INERTIA_WORKSPACE_DIR: workspace, INERTIA_TEST_TEMP_DIR: join(root, "temp"),
  INERTIA_TEST_INSTALLED_UPDATE: root, INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED: codex,
  ELECTRON_DISABLE_SANDBOX: "1" };
delete environment.APPIMAGE;
delete environment.APPDIR;
// The outer guardian deliberately sets no_new_privs. Use the documented
// extraction launch here; the separate final-container gate proves FUSE.
environment.APPIMAGE_EXTRACT_AND_RUN = "1";
let output = "";
const launchers = [];
function launch(path) {
  const child = spawn(path, ["--no-sandbox"], { env: environment, shell: false, detached: true,
    stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
    output = (output + data.toString("utf8")).slice(-64 * 1024);
  });
  launchers.push(child);
  return child;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function wait(label, read, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
const seen = new Set();
async function ready() {
  return await wait("replacement runtime readiness", async () => {
    const results = (await readdir(root)).filter((name) => name.startsWith("result-"));
    for (const name of results) {
      const result = JSON.parse(await readFile(join(root, name), "utf8"));
      if (result.state === "failed" || result.installBlocker) throw new Error(`Installed updater rejected the handoff: ${result.message}`);
    }
    const names = (await readdir(root)).filter((name) => /^ready-\d+\.json$/u.test(name) && !seen.has(name));
    if (!names.length) return null;
    const name = names[0];
    const value = JSON.parse(await readFile(join(root, name), "utf8"));
    seen.add(name);
    return value;
  });
}
const command = (owner, action) => writeFile(join(root, `command-${owner.mainPid}`), action, { flag: "wx", mode: 0o600 });
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
try {
  launch(installed);
  const old = await ready();
  equal(old.appImage, installed);
  const history = await runPackagedHistorySmoke({ websocketUrl: old.websocketUrl, workspaceDirectory: workspace,
    deadlineAt: Date.now() + 30_000 });
  await writeFile(join(root, "history.json"), JSON.stringify(history), { mode: 0o600 });
  const sentinel = Buffer.from(randomUUID());
  await writeFile(join(root, "data", "user-owned-file"), sentinel, { mode: 0o600 });
  await command(old, "install");
  const replacement = await ready();
  ok(replacement.mainPid !== old.mainPid && replacement.runtimePid !== old.runtimePid);
  await wait("previous main/runtime shutdown", () => !alive(old.mainPid) && !alive(old.runtimePid));
  const stable = join(root, "Inertia.AppImage");
  equal(replacement.appImage, stable);
  equal(replacement.profile, old.profile);
  equal(replacement.version, version);
  equal(await digest(stable), await digest(candidate));
  const newHistory = await resumePackagedHistorySmoke(replacement.websocketUrl, history);
  await runPackagedWorkspaceDiscovery(replacement.websocketUrl, history.project.id);
  await command(replacement, "quit");
  await wait("replacement shutdown", () => !alive(replacement.mainPid) && !alive(replacement.runtimePid));
  await assertHistoryAfterShutdown(root, history);
  await assertHistoryAfterShutdown(root, newHistory);
  equal((await readFile(join(root, "data", "user-owned-file"))).toString(), sentinel.toString());
  launch(stable);
  const reopened = await ready();
  equal(reopened.profile, old.profile);
  const reopenedHistory = await resumePackagedHistorySmoke(reopened.websocketUrl, newHistory);
  await command(reopened, "quit");
  await wait("reopened installed app shutdown", () => !alive(reopened.mainPid) && !alive(reopened.runtimePid));
  await assertHistoryAfterShutdown(root, reopenedHistory);
  console.log(`Installed Linux ${process.arch} update passed: real candidate bootstrap, old-owner shutdown, atomic replacement, same profile/history/settings/provider sessions, new turns, and fresh relaunch.`);
} catch (error) {
  console.error(output);
  console.error(`Installed update evidence retained at ${root}`);
  for (const name of await readdir(root)) {
    if (name.startsWith("result-")) console.error(name, await readFile(join(root, name), "utf8"));
  }
  throw error;
} finally {
  for (const name of await readdir(root)) {
    if (!/^ready-\d+\.json$/u.test(name)) continue;
    const state = JSON.parse(await readFile(join(root, name), "utf8"));
    if (alive(state.mainPid)) await command(state, "quit").catch(() => undefined);
  }
  for (const child of launchers) child.unref();
}
