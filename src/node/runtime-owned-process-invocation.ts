import type { RuntimeOwnedProcessPlatform } from "./runtime-owned-process-journal.js";
import {
  linuxGuardianExecutableMatches,
  type LinuxGuardianExecutableIdentity,
} from "./runtime-owned-process-linux.js";

export interface RuntimeOwnedProcessInvocation {
  readonly command: string;
  readonly args: string[];
}

function invocationFor(
  platform: RuntimeOwnedProcessPlatform | null,
  guardianPath: string | null,
  linuxGuardianExecutable: LinuxGuardianExecutableIdentity | null,
  command: string,
  args: readonly string[],
  darwinMode: "watch" | "watch-terminal-session",
): RuntimeOwnedProcessInvocation {
  if (platform !== "darwin" && platform !== "linux") {
    return { command, args: [...args] };
  }
  if (!guardianPath) {
    throw new Error("The runtime process guardian is unavailable.");
  }
  if (platform === "linux") {
    if (!linuxGuardianExecutable
      || !linuxGuardianExecutableMatches(guardianPath, linuxGuardianExecutable)) {
      throw new Error("The Linux runtime process guardian is invalid.");
    }
    return {
      command: guardianPath,
      args: [
        "watch", String(process.pid),
        linuxGuardianExecutable.guardianExecutableDevice,
        linuxGuardianExecutable.guardianExecutableInode,
        "--", command, ...args,
      ],
    };
  }
  return {
    command: guardianPath,
    args: [
      darwinMode,
      String(process.pid),
      "--",
      command,
      ...args,
    ],
  };
}

/** Wraps POSIX runtime children in the strict native guardian without a shell. */
export function runtimeOwnedProcessInvocationFor(
  platform: RuntimeOwnedProcessPlatform | null,
  guardianPath: string | null,
  linuxGuardianExecutable: LinuxGuardianExecutableIdentity | null,
  command: string,
  args: readonly string[],
): RuntimeOwnedProcessInvocation {
  return invocationFor(
    platform,
    guardianPath,
    linuxGuardianExecutable,
    command,
    args,
    "watch",
  );
}

/** Wraps only a user-interactive PTY in its explicit macOS session boundary. */
export function runtimeOwnedTerminalSessionInvocationFor(
  platform: RuntimeOwnedProcessPlatform | null,
  guardianPath: string | null,
  linuxGuardianExecutable: LinuxGuardianExecutableIdentity | null,
  command: string,
  args: readonly string[],
): RuntimeOwnedProcessInvocation {
  return invocationFor(
    platform,
    guardianPath,
    linuxGuardianExecutable,
    command,
    args,
    "watch-terminal-session",
  );
}
