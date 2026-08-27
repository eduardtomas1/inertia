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

if (process.platform !== "darwin" && process.platform !== "linux") process.exit(0);

const linuxGnuTriplet = process.arch === "x64"
  ? "x86_64-linux-gnu"
  : process.arch === "arm64"
    ? "aarch64-linux-gnu"
    : null;
if (process.platform === "linux" && !linuxGnuTriplet) {
  throw new Error(`The Linux runtime process guardian does not support ${process.arch}.`);
}

const compiler = process.platform === "darwin" ? "/usr/bin/xcrun" : "/usr/bin/musl-gcc";
const compilerArgs = process.platform === "darwin"
  ? ["clang"]
  : [
      "-static-pie",
      "-s",
      "-idirafter",
      "/usr/include",
      "-idirafter",
      `/usr/include/${linuxGnuTriplet}`,
    ];

const result = spawnSync(
  compiler,
  [
    ...compilerArgs,
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(root, "native", "runtime-process-guardian", `${process.platform}.c`),
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
  if (process.platform === "linux" && result.error?.code === "ENOENT") {
    throw new Error(
      "The Linux runtime process guardian requires musl-tools, linux-libc-dev, and binutils.",
    );
  }
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  throw new Error(detail || `The ${process.platform} runtime process guardian could not be built.`);
}
chmodSync(output, 0o755);
