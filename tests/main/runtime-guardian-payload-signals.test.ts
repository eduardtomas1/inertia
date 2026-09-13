import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { it } from "vitest";

it.runIf(process.platform === "linux")("restores payload signals and reports native pre-exec failures", () => {
  execFileSync(process.execPath, ["--experimental-strip-types",
    resolve("tests/fixtures/linux-guardian-payload-signals.ts")], {
    timeout: 45_000, maxBuffer: 128 * 1024, stdio: "pipe",
  });
}, 50_000);
