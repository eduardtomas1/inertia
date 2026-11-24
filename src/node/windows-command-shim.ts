import { extname, win32 } from "node:path";

import { WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY } from "./windows-current-directory-search";

export interface WindowsCommandShimInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const WINDOWS_CURRENT_DIRECTORY_SEARCH_GUARD = `set ${WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY}=1&`;
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;,=*? ])/gu;
const UNSAFE_CMD_CHARACTERS = /[\u0000-\u001f\u007f"]/u;

function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const normalized = key.toUpperCase();
  const match = Object.keys(environment).find((candidate) => candidate.toUpperCase() === normalized);
  return match ? environment[match] : undefined;
}

export function windowsCommandProcessor(environment: NodeJS.ProcessEnv): string {
  const configured = windowsEnvironmentValue(environment, "ComSpec");
  if (configured && win32.isAbsolute(configured)) return configured;
  const systemRoot = windowsEnvironmentValue(environment, "SystemRoot");
  if (systemRoot && win32.isAbsolute(systemRoot)) return win32.join(systemRoot, "System32", "cmd.exe");
  return "C:\\Windows\\System32\\cmd.exe";
}

function assertSafeCmdValue(value: string, errorMessage: string): void {
  if (UNSAFE_CMD_CHARACTERS.test(value)) {
    throw new Error(errorMessage);
  }
}

export function escapeWindowsCmdCommand(value: string, errorMessage: string): string {
  assertSafeCmdValue(value, errorMessage);
  return value.replace(CMD_META_CHARACTERS, "^$1");
}

export function escapeWindowsCmdArgument(value: string, errorMessage: string): string {
  assertSafeCmdValue(value, errorMessage);
  const quoted = `"${value.replace(/(\\+)$/u, "$1$1")}"`;
  return quoted.replace(CMD_META_CHARACTERS, "^$1");
}

export function isWindowsCommandShim(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && [".cmd", ".bat"].includes(extname(executable).toLowerCase());
}

export function buildWindowsCommandShimInvocation(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  {
    guardCurrentDirectorySearch = true,
    unsafeErrorMessage = "The command contains characters that cannot be passed safely to a Windows command shim.",
  }: {
    guardCurrentDirectorySearch?: boolean;
    unsafeErrorMessage?: string;
  } = {},
): WindowsCommandShimInvocation {
  if (!isWindowsCommandShim(executable, platform)) {
    return { command: executable, args: [...args] };
  }
  const commandLine = [
    escapeWindowsCmdCommand(executable, unsafeErrorMessage),
    ...args.map((arg) => escapeWindowsCmdArgument(arg, unsafeErrorMessage)),
  ].join(" ");
  const guard = guardCurrentDirectorySearch ? WINDOWS_CURRENT_DIRECTORY_SEARCH_GUARD : "";
  return {
    command: windowsCommandProcessor(environment),
    args: ["/d", "/s", "/v:off", "/c", `"${guard}${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
