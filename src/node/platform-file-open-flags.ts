import { constants as fsConstants } from "node:fs";

export interface FileOpenFlagSource {
  readonly O_DIRECTORY?: number;
  readonly O_NOFOLLOW?: number;
}

export interface PlatformFileOpenFlags {
  readonly directory: number;
  readonly noFollow: number;
}

// Electron 44.0.0's Linux ARM64 binary exposed the Linux x64 values for these
// architecture-specific open(2) flags. Passing those values to an ARM64 kernel
// turns O_DIRECTORY | O_NOFOLLOW into an invalid O_DIRECT combination. Electron
// 44.1.0 corrected its startup snapshot; keep the canonical kernel ABI values
// centralized as a compatibility fallback so an older or stale runtime snapshot
// cannot weaken privileged no-follow and directory-only filesystem boundaries.
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
