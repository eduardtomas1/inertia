import { existsSync } from "node:fs";

import {
  runtimeOwnedPtyInvocation,
  runtimeOwnedTerminalSessionPtyInvocation,
} from "../node/runtime-owned-pty-invocation";

export type TerminalOwnershipBoundary = "complete-tree" | "terminal-session";

export function userShell(
  platform: NodeJS.Platform,
): { executable: string; args: string[] } {
  if (platform === "win32") {
    return { executable: process.env.ComSpec || "powershell.exe", args: [] };
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
