import { statSync } from "node:fs";

import type { RuntimeOwnedProcessPlatform } from "./runtime-owned-process-journal.js";

export interface RuntimeOwnedProcessInvocation {
  readonly command: string;
  readonly args: string[];
}

/** Wraps POSIX runtime children in the native guardian without a shell. */
export function runtimeOwnedProcessInvocationFor(
  platform: RuntimeOwnedProcessPlatform | null,
  guardianPath: string | null,
  command: string,
  args: readonly string[],
): RuntimeOwnedProcessInvocation {
  if (platform !== "darwin" && platform !== "linux") {
    return { command, args: [...args] };
  }
  if (!guardianPath) {
    throw new Error("The runtime process guardian is unavailable.");
  }
  if (platform === "linux") {
    const executable = statSync(guardianPath, { bigint: true });
    if (!executable.isFile()) {
      throw new Error("The Linux runtime process guardian is invalid.");
    }
    return {
      command: guardianPath,
      args: [
        "watch", String(process.pid), String(executable.dev), String(executable.ino),
        "--", command, ...args,
      ],
    };
  }
  return {
    command: guardianPath,
    args: ["watch", String(process.pid), "--", command, ...args],
  };
}
