import { resolve } from "node:path";

import { spawn as spawnPty } from "node-pty";

const root = resolve(import.meta.dirname, "..");
const ptyMarker = "inertia-native-pty-ok";
const successMarker = "inertia-native-pty-probe-passed";
const executable = process.argv[2];
if (!executable) throw new Error("The native PTY probe requires an executable.");

const args = process.platform === "win32"
  ? ["/d", "/s", "/c", `echo ${ptyMarker}`]
  : ["--version"];
const expectedOutput = process.platform === "win32" ? ptyMarker : process.version;
const terminal = spawnPty(executable, args, {
  cols: 80,
  rows: 24,
  cwd: root,
  env: process.env,
});
let output = "";

terminal.onData((chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
terminal.onExit(({ exitCode }) => {
  if (exitCode !== 0 || !output.includes(expectedOutput)) {
    process.stderr.write(
      "The native PTY binding returned an invalid result "
      + `(exit ${exitCode}, output ${JSON.stringify(output.slice(0, 200))}).\n`,
      () => process.exit(1),
    );
    return;
  }
  process.stdout.write(`\n${successMarker}\n`, () => process.exit(0));
});
