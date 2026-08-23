import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import Database from "better-sqlite3";
import { probeNativeExecutable } from "./native-executable-probe.mjs";

const expectedArchitecture = process.env.INERTIA_EXPECTED_ARCH;
if (!new Set(["x64", "arm64"]).has(expectedArchitecture)) {
  throw new Error("INERTIA_EXPECTED_ARCH must be x64 or arm64.");
}
if (process.arch !== expectedArchitecture) {
  throw new Error(
    `Native architecture mismatch: expected ${expectedArchitecture}, running ${process.arch}.`,
  );
}

const platformPackagePrefix = {
  darwin: "darwin",
  win32: "win32",
  linux: "linux",
}[process.platform];
if (!platformPackagePrefix) {
  throw new Error(`Unsupported native architecture probe platform: ${process.platform}.`);
}

const root = resolve(import.meta.dirname, "..");
const claudePackage = `claude-agent-sdk-${platformPackagePrefix}-${process.arch}`;
const claudeDirectory = join(root, "node_modules", "@anthropic-ai", claudePackage);
const claudeManifest = JSON.parse(await readFile(join(claudeDirectory, "package.json"), "utf8"));
if (claudeManifest.name !== `@anthropic-ai/${claudePackage}`) {
  throw new Error("The installed Claude SDK native package does not match the runner architecture.");
}
const claudeExecutable = join(
  claudeDirectory,
  process.platform === "win32" ? "claude.exe" : "claude",
);
const claudeStat = await lstat(claudeExecutable);
if (!claudeStat.isFile() || claudeStat.size <= 0) {
  throw new Error("The Claude SDK native executable is missing or empty.");
}
const claudeVersion = await probeNativeExecutable(claudeExecutable, ["--version"]);
if (claudeVersion.status !== 0 || !/\d+\.\d+\.\d+/u.test(claudeVersion.stdout)) {
  throw new Error("The Claude SDK native executable did not complete its bounded version probe.");
}

const database = new Database(":memory:");
try {
  const row = database.prepare("SELECT 27 AS audit_item").get();
  if (row?.audit_item !== 27) throw new Error("The native SQLite binding returned an invalid result.");
} finally {
  database.close();
}

const canvas = createCanvas(2, 2);
const context = canvas.getContext("2d");
context.fillStyle = "#1f6feb";
context.fillRect(0, 0, 2, 2);
if (canvas.toBuffer("image/png").length <= 8) {
  throw new Error("The native canvas binding did not produce a PNG.");
}

const ptySuccessMarker = "inertia-native-pty-probe-passed";
const windowsPtyEnvironment = {};
if (process.platform === "win32") {
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "Path", "PATHEXT", "TEMP", "TMP"]) {
    const value = Object.entries(process.env).find(
      ([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
    )?.[1]?.trim();
    if (value) windowsPtyEnvironment[name] = value;
  }
}
const ptyExecutable = process.platform === "win32"
  ? windowsPtyEnvironment.ComSpec
    ?? join(windowsPtyEnvironment.SystemRoot ?? windowsPtyEnvironment.WINDIR ?? "C:\\Windows", "System32", "cmd.exe")
  : process.execPath;
// Run the binding in a supervised process because native PTY creation itself
// can block before JavaScript in that process gets a chance to schedule a
// timeout. The outer probe owns the deadline and terminates the complete helper
// process tree on timeout.
const ptyProbe = await probeNativeExecutable(
  process.execPath,
  [join(root, "scripts", "native-pty-probe.mjs"), ptyExecutable],
  {
    environment: process.platform === "win32"
      ? windowsPtyEnvironment
      : { INERTIA_NATIVE_PTY_START_GATE: "1" },
    startAfterOwnership: process.platform !== "win32",
  },
);
if (ptyProbe.status !== 0 || !ptyProbe.stdout.includes(ptySuccessMarker)) {
  throw new Error(
    "The native PTY binding did not complete its bounded child-process probe "
    + `(exit ${ptyProbe.status}, output ${JSON.stringify(ptyProbe.stdout.slice(0, 200))}).`,
  );
}

console.log(
  `Native architecture probe passed for ${process.platform}/${process.arch} `
  + `(Claude ${claudeVersion.stdout.trim()}).`,
);
