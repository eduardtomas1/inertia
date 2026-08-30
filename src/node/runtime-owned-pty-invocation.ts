import {
  activeRuntimeOwnedProcessPlatform,
  runtimeOwnedProcessInvocation,
  runtimeOwnedTerminalSessionInvocation,
} from "./runtime-owned-processes.js";

export interface RuntimeOwnedPtyInvocation {
  readonly command: string;
  readonly args: string[] | string;
}

/** Preserve node-pty's pre-escaped Windows command line verbatim. */
export function runtimeOwnedPtyInvocation(
  command: string,
  args: readonly string[] | string,
): RuntimeOwnedPtyInvocation {
  const platform = activeRuntimeOwnedProcessPlatform();
  if (platform !== "darwin" && platform !== "linux") {
    return { command, args: typeof args === "string" ? args : [...args] };
  }
  return runtimeOwnedProcessInvocation(
    command,
    typeof args === "string" ? [args] : args,
  );
}

/** Selects the explicit session boundary for a user-interactive macOS PTY. */
export function runtimeOwnedTerminalSessionPtyInvocation(
  command: string,
  args: readonly string[] | string,
): RuntimeOwnedPtyInvocation {
  const platform = activeRuntimeOwnedProcessPlatform();
  if (platform !== "darwin" && platform !== "linux") {
    return { command, args: typeof args === "string" ? args : [...args] };
  }
  return runtimeOwnedTerminalSessionInvocation(
    command,
    typeof args === "string" ? [args] : args,
  );
}
