import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLinuxGuardedSmoke } from "../../scripts/linux-guarded-smoke.mjs";
import { linuxProcessCanExecute } from "../../scripts/linux-process-group.mjs";

const roots: string[] = [];
const guardian = resolve("resources/generated/runtime-process-guardian/runtime-process-guardian");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== "linux")("installed smoke native process containment", () => {
  it("returns only after a successful command's descendants are gone", async () => {
    await expect(runLinuxGuardedSmoke({ guardian, command: process.execPath,
      args: ["-e", 'console.log("finished")'], timeoutMs: 2_000 })).resolves.toContain("finished");
  });

  it.each(["failed-before-ready", "unresponsive"])("drains detached descendants when %s", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "inertia-smoke-drain-"));
    roots.push(root);
    const marker = join(root, "child.json");
    const payload = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
        { detached: true, stdio: "ignore" });
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: child.pid }));
      child.unref();
      ${mode === "failed-before-ready" ? "process.exit(1);" : 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'}
    `;
    await expect(runLinuxGuardedSmoke({ guardian, command: process.execPath,
      args: ["-e", payload], timeoutMs: 2_000 })).rejects.toThrow(
      mode === "failed-before-ready" ? "exited with status 1" : "Installed smoke timed out",
    );
    const child = JSON.parse(await readFile(marker, "utf8")) as { pid: number };
    expect(linuxProcessCanExecute(child.pid)).toBe(false);
  }, 15_000);
});
