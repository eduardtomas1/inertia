import {
  activeRuntimeOwnedProcessPlatform,
  runtimeOwnedProcessInvocation,
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
  if (activeRuntimeOwnedProcessPlatform() !== "darwin") {
    return { command, args: typeof args === "string" ? args : [...args] };
  }
  return runtimeOwnedProcessInvocation(
    command,
    typeof args === "string" ? [args] : args,
  );
}
