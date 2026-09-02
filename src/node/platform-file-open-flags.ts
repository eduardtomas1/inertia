import { constants as fsConstants } from "node:fs";

export interface FileOpenFlagSource {
  readonly O_DIRECTORY?: number;
  readonly O_NOFOLLOW?: number;
}

export interface PlatformFileOpenFlags {
  readonly directory: number;
  readonly noFollow: number;
}

// Electron 44.0.0's Linux ARM64 binary exposes the Linux x64 values for these
// architecture-specific open(2) flags. Passing those values to an ARM64 kernel
// turns O_DIRECTORY | O_NOFOLLOW into an invalid O_DIRECT combination. Keep the
// correction centralized so every privileged filesystem boundary retains its
// no-follow and directory-only guarantees until the upstream runtime is fixed.
const LINUX_ARM64_FILE_OPEN_FLAGS: PlatformFileOpenFlags = {
  directory: 0x4000,
  noFollow: 0x8000,
};

export function resolvePlatformFileOpenFlags(options: {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly constants: FileOpenFlagSource;
}): PlatformFileOpenFlags {
  if (options.platform === "linux" && options.architecture === "arm64") {
    return LINUX_ARM64_FILE_OPEN_FLAGS;
  }
  return {
    directory: options.constants.O_DIRECTORY ?? 0,
    noFollow: options.constants.O_NOFOLLOW ?? 0,
  };
}

const platformFileOpenFlags = resolvePlatformFileOpenFlags({
  platform: process.platform,
  architecture: process.arch,
  constants: fsConstants,
});

export const FILE_OPEN_DIRECTORY = platformFileOpenFlags.directory;
export const FILE_OPEN_NO_FOLLOW = platformFileOpenFlags.noFollow;
