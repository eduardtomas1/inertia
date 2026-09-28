import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.runIf(process.platform === "linux")("restores payload signals and reports native pre-exec failures", () => {
  const output = execFileSync(process.execPath, ["--experimental-strip-types",
    "--test-reporter=tap", resolve("tests/fixtures/linux-guardian-payload-signals.ts")], {
    encoding: "utf8", timeout: 45_000, maxBuffer: 128 * 1024, stdio: "pipe",
  });
  const total = (name: string): number =>
    Number(new RegExp(`^# ${name} (\\d+)$`, "mu").exec(output)?.[1] ?? Number.NaN);
  expect(total("tests")).toBeGreaterThan(0);
  expect(total("pass")).toBe(total("tests"));
  expect(total("fail")).toBe(0);
}, 50_000);
