import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAMPLE_SECONDS = 3;
const SAMPLE_BOUND_MS = 12_000;

export const UNEXITED_MAIN_SAMPLE_ATTACHMENT = "electron-unexited-main-sample";

export interface UnexitedMainSampleDependencies {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof spawn;
  readonly attach?: (path: string) => Promise<void>;
  readonly boundMs?: number;
}

async function attachToCurrentTest(path: string): Promise<void> {
  const { test } = await import("@playwright/test");
  await test.info().attach(UNEXITED_MAIN_SAMPLE_ATTACHMENT, { path, contentType: "text/plain" });
}

export async function sampleUnexitedElectronMain(
  pid: number | null | undefined,
  dependencies: UnexitedMainSampleDependencies = {},
): Promise<"attached" | "skipped" | "unavailable"> {
  if ((dependencies.platform ?? process.platform) !== "darwin") return "skipped";
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return "skipped";
  try {
    const file = join(await mkdtemp(join(tmpdir(), "inertia-unexited-main-")), `electron-main-${pid}.sample.txt`);
    await new Promise<void>((resolve) => {
      const tool = (dependencies.spawn ?? spawn)("/usr/bin/sample", [String(pid), String(SAMPLE_SECONDS), "-mayDie", "-file", file], {
        shell: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
      const bound = setTimeout(() => { tool.kill("SIGKILL"); resolve(); }, dependencies.boundMs ?? SAMPLE_BOUND_MS);
      const finish = (): void => { clearTimeout(bound); resolve(); };
      tool.once("error", finish);
      tool.once("exit", finish);
    });
    if ((await stat(file)).size === 0) return "unavailable";
    await (dependencies.attach ?? attachToCurrentTest)(file);
    return "attached";
  } catch {
    return "unavailable";
  }
}
