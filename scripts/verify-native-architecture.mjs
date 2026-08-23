import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import Database from "better-sqlite3";
import { spawn as spawnPty } from "node-pty";

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
const claudeVersion = spawnSync(claudeExecutable, ["--version"], {
  encoding: "utf8",
  env: {},
  maxBuffer: 64 * 1024,
  shell: false,
  timeout: 10_000,
  windowsHide: true,
});
if (claudeVersion.error || claudeVersion.status !== 0 || !/\d+\.\d+\.\d+/u.test(claudeVersion.stdout)) {
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

await new Promise((resolveProbe, rejectProbe) => {
  const terminal = spawnPty(process.execPath, [
    "-e",
    // ConPTY can drop a final unterminated write while draining its output
    // pipe, so make the probe a complete terminal line on every platform.
    "console.log('inertia-native-pty-ok')",
  ], {
    cols: 80,
    rows: 24,
    cwd: root,
    env: {},
  });
  let output = "";
  let settled = false;
  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(() => {
    terminal.kill();
    finish(() => rejectProbe(new Error("The native PTY binding exceeded its 10 second deadline.")));
  }, 10_000);
  terminal.onData((chunk) => {
    output += chunk;
    if (output.length > 64 * 1024) {
      terminal.kill();
      finish(() => rejectProbe(new Error("The native PTY binding exceeded its output limit.")));
    }
  });
  terminal.onExit(({ exitCode }) => {
    if (exitCode !== 0 || !output.includes("inertia-native-pty-ok")) {
      finish(() => rejectProbe(
        new Error("The native PTY binding did not complete its child-process probe."),
      ));
      return;
    }
    finish(resolveProbe);
  });
});

console.log(
  `Native architecture probe passed for ${process.platform}/${process.arch} `
  + `(Claude ${claudeVersion.stdout.trim()}).`,
);
