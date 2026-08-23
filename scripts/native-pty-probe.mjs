import { resolve } from "node:path";

import { spawn as spawnPty } from "node-pty";

const root = resolve(import.meta.dirname, "..");
const ptyMarker = "inertia-native-pty-ok";
const successMarker = "inertia-native-pty-probe-passed";
const startMarker = "inertia-native-probe-start\n";
const executable = process.argv[2];
if (!executable) throw new Error("The native PTY probe requires an executable.");

if (process.env.INERTIA_NATIVE_PTY_START_GATE === "1") {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString("utf8");
    if (Buffer.byteLength(input) > Buffer.byteLength(startMarker)) {
      throw new Error("The native PTY probe received an invalid start marker.");
    }
  }
  if (input !== startMarker) {
    throw new Error("The native PTY probe did not receive its start marker.");
  }
}

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
