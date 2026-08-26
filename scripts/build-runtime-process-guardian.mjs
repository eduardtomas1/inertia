import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = join(
  root,
  "resources",
  "generated",
  "runtime-process-guardian",
);
const output = join(outputDirectory, "runtime-process-guardian");

mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
rmSync(output, { force: true });

if (process.platform !== "darwin") process.exit(0);

const result = spawnSync(
  "/usr/bin/xcrun",
  [
    "clang",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(root, "native", "runtime-process-guardian", "darwin.c"),
    "-o",
    output,
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 30_000,
  },
);
if (result.error || result.status !== 0) {
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  throw new Error(detail || "The macOS runtime process guardian could not be built.");
}
chmodSync(output, 0o755);
