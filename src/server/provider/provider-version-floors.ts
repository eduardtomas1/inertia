import type { ProviderId } from "./contracts";

export interface ProviderVersionFloor {
  product: string;
  minimumVersion: string;
  reason: string;
  remedy: string;
}

export const PROVIDER_VERSION_FLOORS = {
  claude: {
    product: "Claude Code",
    minimumVersion: "2.1.309",
    reason: "older versions ignore the restrictions Inertia sets and can write outside the project",
    remedy: "Update Claude Code and refresh.",
  },
  opencode: {
    product: "OpenCode",
    minimumVersion: "1.18.22",
    reason: "older versions let a website install packages through OpenCode's local server",
    remedy: "Update OpenCode and refresh.",
  },
  antigravity: {
    product: "Antigravity",
    minimumVersion: "1.2.2",
    reason: "older versions have no headless stream-json mode",
    remedy: "Run 'agy update' and refresh.",
  },
} as const satisfies Partial<Record<ProviderId, ProviderVersionFloor>>;

export const OPENCODE_VERSION_CEILING = {
  firstUnsupportedMajor: 3,
  message: "This OpenCode major version is not supported; use OpenCode 1.x or 2.x.",
} as const;

interface ParsedVersion {
  core: readonly [number, number, number];
  prerelease: boolean;
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function parsedVersion(version: string | undefined): ParsedVersion | null {
  const match = version?.trim().match(VERSION_PATTERN);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] as const;
  const prerelease = match[4] !== undefined;
  if (prerelease && core.every((part) => part === 0)) return null;
  return { core, prerelease };
}

export function providerVersionBelowFloor(
  version: string | undefined,
  minimumVersion: string,
): boolean {
  const installed = parsedVersion(version);
  const minimum = parsedVersion(minimumVersion);
  if (!installed || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = installed.core[index]! - minimum.core[index]!;
    if (difference !== 0) return difference < 0;
  }
  return installed.prerelease && !minimum.prerelease;
}

export function providerVersionFloorMessage(
  floor: ProviderVersionFloor,
  installedVersion: string,
): string {
  return `${floor.product} ${installedVersion} is installed. Inertia needs ${floor.minimumVersion} or newer because ${floor.reason}. ${floor.remedy}`;
}
