import { extname, win32 } from "node:path";

import type { ProviderEnvironment } from "../environment";

export interface ProviderProcessInvocation {
  command: string;
  args: string[];
}

function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const normalized = key.toUpperCase();
  const match = Object.keys(environment).find((candidate) => candidate.toUpperCase() === normalized);
  return match ? environment[match] : undefined;
}

function cmdToken(value: string): string {
  if (value.includes("\0") || /[\r\n"]/u.test(value)) {
    throw new Error("The provider command contains characters that cannot be passed safely to a Windows command shim.");
  }
  // Delayed expansion is disabled below. Doubling percent signs prevents
  // environment expansion while preserving literal user paths and arguments.
  return `"${value.replaceAll("%", "%%")}"`;
}

/**
 * Resolve a provider command without enabling Node's generic `shell` mode.
 * Windows batch shims need cmd.exe, but receive one fully quoted command with
 * delayed expansion disabled so spaces, parentheses, and Unicode paths remain
 * data rather than shell syntax.
 */
export function providerProcessInvocation(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ProviderProcessInvocation {
  if (platform !== "win32" || ![".cmd", ".bat"].includes(extname(executable).toLowerCase())) {
    return { command: executable, args: [...args] };
  }
  const commandLine = [executable, ...args].map(cmdToken).join(" ");
  const systemRoot = windowsEnvironmentValue(environment, "SystemRoot");
  const command = windowsEnvironmentValue(environment, "ComSpec")
    || (systemRoot ? win32.join(systemRoot, "System32", "cmd.exe") : "cmd.exe");
  return {
    command,
    args: ["/d", "/s", "/v:off", "/c", commandLine],
  };
}
