import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

import {
  executableCandidates,
  providerEnvironment,
  type ProviderEnvironment,
} from "../environment";
import type {
  ProviderMaintenanceInstallMethod,
  ProviderMaintenanceProviderId,
  ProviderMaintenanceUpdateAvailability,
} from "../../shared/provider-maintenance";

export interface ProviderMaintenanceTarget {
  providerId: ProviderMaintenanceProviderId;
  executable: string | null;
  installedVersion: string | null;
  installed: boolean;
}

export interface ProviderMaintenanceUpdateAction {
  executable: string;
  args: readonly string[];
  environmentPathPrefix?: string;
  lockKey: string;
  installMethod: ProviderMaintenanceInstallMethod;
  label: string;
}

export interface ProviderMaintenanceCapabilities {
  providerId: ProviderMaintenanceProviderId;
  packageName: string | null;
  installMethod: ProviderMaintenanceInstallMethod;
  updateAvailability: ProviderMaintenanceUpdateAvailability;
  update: ProviderMaintenanceUpdateAction | null;
  instructionsUrl: string;
  message?: string;
}

export interface ProviderMaintenanceCapabilityDependencies {
  environment?: () => Promise<ProviderEnvironment>;
  executableCandidates?: typeof executableCandidates;
  platform?: NodeJS.Platform;
  access?: (path: string, mode: number) => Promise<void>;
  realpath?: (path: string) => Promise<string>;
}

const PACKAGE_NAMES: Readonly<
  Partial<Record<ProviderMaintenanceProviderId, string>>
> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  kimi: "@moonshot-ai/kimi-code",
  opencode: "opencode-ai",
};

const INSTRUCTIONS_URLS: Readonly<
  Record<ProviderMaintenanceProviderId, string>
> = {
  codex: "https://github.com/openai/codex#installing-and-running-codex-cli",
  claude: "https://docs.anthropic.com/en/docs/claude-code/getting-started#update-claude-code",
  cursor: "https://docs.cursor.com/en/cli/installation#updates",
  kimi: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
  opencode: "https://opencode.ai/docs/cli/#upgrade",
  antigravity: "https://antigravity.google/docs/cli/install/",
};

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

/**
 * Codex does not expose a documented self-update command. We therefore only
 * execute a package-manager update when the canonical binary path proves which
 * supported manager owns it. Unknown or standalone paths remain manual.
 */
export function codexInstallMethodFromPath(
  executable: string,
): ProviderMaintenanceInstallMethod {
  const normalized = normalizedPath(executable);
  if (
    normalized.includes("/cellar/codex/")
    || normalized.includes("/caskroom/codex/")
  ) {
    return "homebrew";
  }
  if (
    normalized.includes("/node_modules/@openai/codex/")
    || normalized.includes("/lib/node_modules/@openai/codex/")
    || normalized.includes("/node_modules/.bin/codex")
    || (
      normalized.includes("/appdata/roaming/npm/")
      && /\/codex\.(?:bat|cmd|exe)$/u.test(normalized)
    )
  ) {
    return "npm-global";
  }
  return "manual";
}

async function resolvedManager(
  command: string,
  environment: ProviderEnvironment,
  dependencies: ProviderMaintenanceCapabilityDependencies,
): Promise<string | null> {
  const candidates = await (
    dependencies.executableCandidates ?? executableCandidates
  )(command, environment);
  return candidates[0] ?? null;
}

interface NpmManagerLocation {
  command: string;
  pathPrefix: string;
  prefix: string;
}

/**
 * Bind npm maintenance to the installation root that owns the selected CLI.
 * Selecting an unrelated npm from PATH can update a different global prefix
 * or require privileges that the detected per-user installation does not need.
 */
function npmManagerLocation(
  executable: string,
  packagePath: string,
  commandName: string,
  platform: NodeJS.Platform,
): NpmManagerLocation | null {
  const path = platform === "win32" ? win32 : posix;
  const normalized = path.normalize(executable);
  if (!path.isAbsolute(normalized)) return null;
  const comparable = normalized.replaceAll("\\", "/");
  const searched =
    platform === "win32" ? comparable.toLocaleLowerCase("en-US") : comparable;
  const marker =
    platform === "win32"
      ? `/node_modules/${packagePath}/`
      : `/lib/node_modules/${packagePath}/`;
  const markerIndex = searched.indexOf(marker);
  if (markerIndex > 0) {
    const prefix = normalized.slice(0, markerIndex);
    const pathPrefix = platform === "win32" ? prefix : path.join(prefix, "bin");
    return {
      command: path.join(pathPrefix, platform === "win32" ? "npm.cmd" : "npm"),
      pathPrefix,
      prefix,
    };
  }
  if (
    platform === "win32" &&
    [`${commandName}.bat`, `${commandName}.cmd`, `${commandName}.exe`].includes(
      path.basename(normalized).toLocaleLowerCase("en-US"),
    )
  ) {
    const pathPrefix = path.dirname(normalized);
    return { command: path.join(pathPrefix, "npm.cmd"), pathPrefix, prefix: pathPrefix };
  }
  return null;
}

function codexNpmManagerLocation(
  executable: string,
  platform: NodeJS.Platform,
): NpmManagerLocation | null {
  return npmManagerLocation(executable, "@openai/codex", "codex", platform);
}

function manualCapabilities(
  target: ProviderMaintenanceTarget,
  installMethod: ProviderMaintenanceInstallMethod,
  message?: string,
): ProviderMaintenanceCapabilities {
  return {
    providerId: target.providerId,
    packageName: PACKAGE_NAMES[target.providerId] ?? null,
    installMethod,
    updateAvailability: target.installed ? "instructions-only" : "unavailable",
    update: null,
    instructionsUrl: INSTRUCTIONS_URLS[target.providerId],
    ...(message ? { message } : {}),
  };
}

async function posixNpmInstallationProblem(
  location: NpmManagerLocation,
  executable: string,
  dependencies: ProviderMaintenanceCapabilityDependencies,
): Promise<string | null> {
  const resolvePath = dependencies.realpath ?? realpath;
  const checkAccess = dependencies.access ?? access;
  const directories = [
    location.prefix,
    posix.join(location.prefix, "lib"),
    posix.join(location.prefix, "lib/node_modules"),
    posix.join(location.prefix, "lib/node_modules/@openai"),
    posix.join(location.prefix, "lib/node_modules/@openai/codex"),
    location.pathPrefix,
  ];
  try {
    // The selected CLI and npm's global bin must name the same installation.
    // Reject redirected package/bin directories before granting write access.
    for (const directory of directories) {
      if (await resolvePath(directory) !== directory) {
        throw new Error("Redirected npm installation");
      }
    }
    if (await resolvePath(posix.join(location.pathPrefix, "codex")) !== executable) {
      throw new Error("Different npm executable");
    }
  } catch {
    return "Inertia could not verify the npm installation that owns this Codex executable. Update it with its original installer; see Instructions.";
  }
  try {
    // Existing parent directories need traversal, not write permission (for
    // example an Intel Homebrew prefix at /usr/local can be root-owned).
    for (const directory of directories.slice(2)) {
      await checkAccess(directory, constants.W_OK | constants.X_OK);
    }
  } catch {
    return "This Codex installation is not writable by your account. Update it with its original installer, or use a user-owned npm installation; see Instructions.";
  }
  return null;
}

async function posixNpmRuntime(
  manager: string,
  environment: ProviderEnvironment,
  dependencies: ProviderMaintenanceCapabilityDependencies,
): Promise<{ node: string; pathPrefix: string } | null> {
  // executableCandidates returns canonical paths. Recognize npm's own entry
  // point, including the Ubuntu/Mint distro layout, without executing shims.
  const match = /^(.*)\/(?:lib\/node_modules|share\/nodejs)\/npm\/bin\/npm-cli\.js$/u.exec(manager);
  if (!match?.[1] || !posix.isAbsolute(manager)) return null;
  const pathPrefix = posix.join(match[1], "bin");
  const node = await resolvedManager(posix.join(pathPrefix, "node"), environment, dependencies);
  return node ? { node, pathPrefix } : null;
}

function providerManagedCapabilities(
  target: ProviderMaintenanceTarget,
  args: readonly string[],
): ProviderMaintenanceCapabilities {
  if (!target.installed || !target.executable) {
    return manualCapabilities(target, "unknown");
  }
  return {
    providerId: target.providerId,
    packageName: PACKAGE_NAMES[target.providerId] ?? null,
    installMethod: "provider-managed",
    updateAvailability: "available",
    update: {
      executable: target.executable,
      args,
      lockKey: `provider-managed:${target.providerId}`,
      installMethod: "provider-managed",
      label: `Update ${target.providerId === "opencode" ? "OpenCode" : target.providerId === "claude" ? "Claude" : "Cursor"}`,
    },
    instructionsUrl: INSTRUCTIONS_URLS[target.providerId],
  };
}

export async function resolveProviderMaintenanceCapabilities(
  target: ProviderMaintenanceTarget,
  dependencies: ProviderMaintenanceCapabilityDependencies = {},
): Promise<ProviderMaintenanceCapabilities> {
  if (target.providerId === "claude") {
    return providerManagedCapabilities(target, ["update"]);
  }
  if (target.providerId === "cursor") {
    return providerManagedCapabilities(target, ["update"]);
  }
  if (target.providerId === "kimi") {
    // The documented self-updater requires an interactive choice. The
    // maintenance runner is intentionally non-interactive, so exposing it as
    // a one-click action would only hang until the bounded timeout.
    return manualCapabilities(target, "provider-managed");
  }
  if (target.providerId === "opencode") {
    return providerManagedCapabilities(target, ["upgrade"]);
  }
  if (!target.installed || !target.executable) {
    return manualCapabilities(target, "unknown");
  }

  if (target.providerId !== "codex") return manualCapabilities(target, "manual");

  const installMethod = codexInstallMethodFromPath(target.executable);
  if (installMethod !== "npm-global" && installMethod !== "homebrew") {
    return manualCapabilities(target, installMethod,
      "Inertia could not identify a supported updater for this Codex installation. Update it with its original installer; see Instructions.");
  }
  const environment = await (
    dependencies.environment ?? (() => providerEnvironment())
  )();
  const platform = dependencies.platform ?? process.platform;
  const npmManager = installMethod === "npm-global"
    ? codexNpmManagerLocation(target.executable, platform)
    : null;
  if (installMethod === "npm-global" && !npmManager) {
    return manualCapabilities(target, installMethod,
      "This Codex installation does not use a supported npm global layout. Update it with its original installer; see Instructions.");
  }
  if (npmManager && platform !== "win32") {
    const problem = await posixNpmInstallationProblem(npmManager, target.executable, dependencies);
    if (problem) return manualCapabilities(target, installMethod, problem);
  }
  const manager = await resolvedManager(
    npmManager?.command ?? "brew",
    environment,
    dependencies,
  ) ?? (npmManager && platform !== "win32"
    ? await resolvedManager("npm", environment, dependencies)
    : null);
  if (!manager) return manualCapabilities(target, installMethod,
    `Inertia could not find ${installMethod === "npm-global" ? "npm" : "Homebrew"} to update this Codex installation. Make the package manager available, then check again; see Instructions.`);
  const npmRuntime = npmManager && platform !== "win32"
    ? await posixNpmRuntime(manager, environment, dependencies)
    : null;
  if (npmManager && platform !== "win32" && !npmRuntime) {
    return manualCapabilities(target, installMethod,
      "Inertia could not pair npm with its Node executable. Make a standard Node and npm installation available, then check again; see Instructions.");
  }

  return {
    providerId: "codex",
    packageName: "@openai/codex",
    installMethod,
    updateAvailability: "available",
    update: installMethod === "npm-global"
      ? {
          executable: npmRuntime?.node ?? manager,
          args: [...(npmRuntime ? [manager] : []), "install", "-g", ...(platform !== "win32" && npmManager
            ? ["--prefix", npmManager.prefix] : []), "@openai/codex@latest"],
          environmentPathPrefix: npmRuntime?.pathPrefix ?? npmManager?.pathPrefix,
          lockKey: "package-manager:npm-global",
          installMethod,
          label: "Update Codex with npm",
        }
      : {
          executable: manager,
          args: ["upgrade", "--cask", "codex"],
          lockKey: "package-manager:homebrew",
          installMethod,
          label: "Update Codex with Homebrew",
        },
    instructionsUrl: INSTRUCTIONS_URLS.codex,
  };
}
