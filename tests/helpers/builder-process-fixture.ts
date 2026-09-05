import { writeFileSync } from "node:fs";

export function writeLongRunningBuilder(builder: string, pidFile: string): void {
  writeFileSync(
    builder,
    [
      'import { spawn } from "node:child_process";',
      'import { renameSync, writeFileSync } from "node:fs";',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, JSON.stringify({ root: process.pid, descendant: descendant.pid }));`,
      `renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
}
