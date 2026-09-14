import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { runLinuxGuardedSmoke } from "../../scripts/linux-guarded-smoke.mjs";
import { linuxProcessCanExecute } from "../../scripts/linux-process-group.mjs";

const guardian = process.argv[2] ?? resolve("resources/generated/runtime-process-guardian/runtime-process-guardian");
const helper = pathToFileURL(resolve("scripts/linux-guarded-smoke.mjs")).href;

for (const releasePipes of [false, true]) {
  void it(`drains retained launcher pipes after functional completion (release: ${releasePipes})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-smoke-launcher-pipes-"));
    const marker = join(root, "descendant.json");
    let preserve = false;
    try {
      const payload = `
        import { spawn } from "node:child_process";
        import { once } from "node:events";
        import { writeFileSync } from "node:fs";
        import { releaseLinuxSmokeLauncherHandles } from ${JSON.stringify(helper)};
        const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");',
        )}], {
          detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
        });
        await once(descendant.stdout, "data");
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: descendant.pid }));
        console.log("functional checks passed");
        ${releasePipes ? "releaseLinuxSmokeLauncherHandles([descendant]);" : "descendant.unref();"}
      `;
      const result = runLinuxGuardedSmoke({ guardian, command: process.execPath,
        args: ["--input-type=module", "-e", payload], timeoutMs: 2_000 });
      if (releasePipes) {
        assert.match(await result, /functional checks passed/u);
      } else {
        await assert.rejects(result, /Installed smoke timed out\.[\s\S]*functional checks passed/u);
      }
      const descendant = JSON.parse(await readFile(marker, "utf8")) as { pid: number };
      // Both paths still require the real guardian's child-free terminal state
      // and process-group cleanup proof. Releasing pipes cannot replace that.
      assert.equal(linuxProcessCanExecute(descendant.pid), false);
    } catch (error) {
      preserve = (error as { preserveTemporaryRoot?: boolean }).preserveTemporaryRoot === true;
      throw error;
    } finally {
      if (!preserve) await rm(root, { recursive: true, force: true });
    }
  });
}
