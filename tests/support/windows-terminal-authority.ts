import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WindowsTerminalAuthority } from "../../src/node/windows-terminal-authority";

export function testWindowsTerminalAuthority(): WindowsTerminalAuthority | undefined {
  if (process.platform !== "win32") return undefined;
  const integrity = JSON.parse(readFileSync(resolve(
    "resources/generated/windows-runtime-job-integrity.json",
  ), "utf8")) as { sha256: string };
  return {
    path: resolve("resources/generated/runtime-process-guardian/windows-runtime-job.exe"),
    sha256: integrity.sha256,
  };
}
