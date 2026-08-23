import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  expect(processExists(pid)).toBe(false);
}

function forceCleanup(pid: number): void {
  if (!processExists(pid)) return;
  if (process.platform === "win32") {
    const systemRoot = Object.entries(process.env).find(([name]) =>
      ["systemroot", "windir"].includes(name.toLowerCase()))?.[1];
    if (systemRoot && win32.isAbsolute(systemRoot)) {
      spawnSync(win32.join(systemRoot, "System32", "taskkill.exe"), [
        "/pid", String(pid), "/t", "/f",
      ], { stdio: "ignore", windowsHide: true });
    }
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* The process may already be gone. */ }
}

test("enforces the native executable deadline on its complete process tree", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "inertia-native-probe-"));
  const pidFile = join(temporaryDirectory, "descendant.pid");
  let descendantPid = 0;
  try {
    const moduleUrl = pathToFileURL(join(root, "scripts", "native-executable-probe.mjs")).href;
    const { probeNativeExecutable } = await import(moduleUrl) as {
      probeNativeExecutable: (
        command: string,
        args: string[],
        options: { environment: NodeJS.ProcessEnv; timeoutMs: number },
      ) => Promise<unknown>;
    };
    const startedAt = Date.now();
    const probe = probeNativeExecutable(process.execPath, [
      join(import.meta.dirname, "..", "fixtures", "native-executable-probe-child.mjs"),
    ], {
      environment: { INERTIA_PROBE_PID_FILE: pidFile },
      timeoutMs: 1_000,
    });
    await expect(probe).rejects.toThrow("exceeded its 1000ms deadline");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    descendantPid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    await waitForExit(descendantPid);
  } finally {
    forceCleanup(descendantPid);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
