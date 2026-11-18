import { existsSync } from "node:fs";
import { win32 } from "node:path";

import {
  runtimeOwnedPtyInvocation,
  runtimeOwnedTerminalSessionPtyInvocation,
} from "../node/runtime-owned-pty-invocation";

export type TerminalOwnershipBoundary = "complete-tree" | "terminal-session";

export function userShell(
  platform: NodeJS.Platform,
): { executable: string; args: string[] } {
  if (platform === "win32") {
    const comSpec = process.env.ComSpec;
    if (comSpec && win32.isAbsolute(comSpec)) return { executable: comSpec, args: [] };
    const configuredSystemRoot = process.env.SystemRoot;
    const systemRoot = configuredSystemRoot && win32.isAbsolute(configuredSystemRoot) ? configuredSystemRoot : undefined;
    if (comSpec && systemRoot) return { executable: win32.join(systemRoot, "System32", "cmd.exe"), args: [] };
    return {
      executable: systemRoot
        ? win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : "powershell.exe",
      args: [],
    };
  }

  const configuredShell = process.env.SHELL;
  if (configuredShell && configuredShell.startsWith("/") && existsSync(configuredShell)) {
    return { executable: configuredShell, args: ["-l"] };
  }

  const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return { executable: fallback, args: ["-l"] };
}

/**
 * Terminal sessions intentionally preserve their interactive Darwin shell;
 * every provider and direct process keeps complete-tree ownership instead.
 */
export function runtimeOwnedPtyInvocationForBoundary(
  platform: NodeJS.Platform,
  ownershipBoundary: TerminalOwnershipBoundary,
  executable: string,
  args: readonly string[] | string,
) {
  return platform === "darwin" && ownershipBoundary === "terminal-session"
    ? runtimeOwnedTerminalSessionPtyInvocation(executable, args)
    : runtimeOwnedPtyInvocation(executable, args);
}
