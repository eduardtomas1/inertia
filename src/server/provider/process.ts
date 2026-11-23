import {
  buildWindowsCommandShimInvocation,
  type WindowsCommandShimInvocation,
} from "../../node/windows-command-shim";

export type ProviderProcessInvocation = WindowsCommandShimInvocation;

export function providerPtyArguments(invocation: ProviderProcessInvocation): readonly string[] | string {
  return invocation.windowsVerbatimArguments ? invocation.args.join(" ") : invocation.args;
}

export function providerProcessInvocation(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  { guardCurrentDirectorySearch = true }: { guardCurrentDirectorySearch?: boolean } = {},
): ProviderProcessInvocation {
  return buildWindowsCommandShimInvocation(executable, args, environment, platform, {
    guardCurrentDirectorySearch,
    unsafeErrorMessage: "The provider command contains characters that cannot be passed safely to a Windows command shim.",
  });
}
