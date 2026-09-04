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
}

export interface ProviderMaintenanceCapabilityDependencies {
  environment?: () => Promise<ProviderEnvironment>;
  executableCandidates?: typeof executableCandidates;
  platform?: NodeJS.Platform;
}

const PACKAGE_NAMES: Readonly<
  Partial<Record<ProviderMaintenanceProviderId, string>>
> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  gemini: "@google/gemini-cli",
  kimi: "@moonshot-ai/kimi-code",
  opencode: "opencode-ai",
};

const INSTRUCTIONS_URLS: Readonly<
  Record<ProviderMaintenanceProviderId, string>
> = {
  codex: "https://github.com/openai/codex#installing-and-running-codex-cli",
  claude: "https://docs.anthropic.com/en/docs/claude-code/getting-started#update-claude-code",
  cursor: "https://docs.cursor.com/en/cli/installation#updates",
  gemini: "https://geminicli.com/docs/get-started/installation/",
  kimi: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
  opencode: "https://opencode.ai/docs/cli/#upgrade",
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

/**
 * Gemini has no bounded non-interactive self-updater. Only canonical npm or
 * Homebrew installation paths prove which package manager owns the selected
 * executable; aliases and arbitrary wrapper paths stay instructions-only.
 */
export function geminiInstallMethodFromPath(
  executable: string,
): ProviderMaintenanceInstallMethod {
  const normalized = normalizedPath(executable);
  if (normalized.includes("/cellar/gemini-cli/")) {
    return "homebrew";
  }
  if (
    normalized.includes("/node_modules/@google/gemini-cli/") ||
    normalized.includes("/lib/node_modules/@google/gemini-cli/") ||
    normalized.includes("/node_modules/.bin/gemini") ||
    (normalized.includes("/appdata/roaming/npm/") &&
      /\/gemini\.(?:bat|cmd|exe)$/u.test(normalized))
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
  if (markerIndex >= 0) {
    const prefix = normalized.slice(0, markerIndex);
    const pathPrefix = platform === "win32" ? prefix : path.join(prefix, "bin");
    return {
      command: path.join(pathPrefix, platform === "win32" ? "npm.cmd" : "npm"),
      pathPrefix,
    };
  }
  if (
    platform === "win32" &&
    [`${commandName}.bat`, `${commandName}.cmd`, `${commandName}.exe`].includes(
      path.basename(normalized).toLocaleLowerCase("en-US"),
    )
  ) {
    const pathPrefix = path.dirname(normalized);
    return { command: path.join(pathPrefix, "npm.cmd"), pathPrefix };
  }
  return null;
}

function codexNpmManagerLocation(
  executable: string,
  platform: NodeJS.Platform,
): NpmManagerLocation | null {
  return npmManagerLocation(executable, "@openai/codex", "codex", platform);
}

function geminiNpmManagerLocation(
  executable: string,
  platform: NodeJS.Platform,
): NpmManagerLocation | null {
  return npmManagerLocation(
    executable,
    "@google/gemini-cli",
    "gemini",
    platform,
  );
}

function geminiHomebrewManagerLocation(executable: string): string | null {
  const normalized = posix.normalize(executable.replaceAll("\\", "/"));
  if (!posix.isAbsolute(normalized)) return null;
  const searched = normalized.toLocaleLowerCase("en-US");
  const marker = "/cellar/gemini-cli/";
  if (!searched.includes(marker)) return null;
  const prefix = normalized.slice(0, searched.indexOf(marker)) || "/";
  return posix.join(prefix, "bin", "brew");
}

function manualCapabilities(
  target: ProviderMaintenanceTarget,
  installMethod: ProviderMaintenanceInstallMethod,
): ProviderMaintenanceCapabilities {
  return {
    providerId: target.providerId,
    packageName: PACKAGE_NAMES[target.providerId] ?? null,
    installMethod,
    updateAvailability: target.installed ? "instructions-only" : "unavailable",
    update: null,
    instructionsUrl: INSTRUCTIONS_URLS[target.providerId],
  };
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
  if (target.providerId === "gemini") {
    if (!target.installed || !target.executable) {
      return manualCapabilities(target, "unknown");
    }
    const installMethod = geminiInstallMethodFromPath(target.executable);
    if (installMethod !== "npm-global" && installMethod !== "homebrew") {
      return manualCapabilities(target, installMethod);
    }
    const platform = dependencies.platform ?? process.platform;
    const npmManager =
      installMethod === "npm-global"
        ? geminiNpmManagerLocation(target.executable, platform)
        : null;
    const managerCommand = npmManager?.command
      ?? geminiHomebrewManagerLocation(target.executable);
    if (!managerCommand) {
      return manualCapabilities(target, installMethod);
    }
    const environment = await (
      dependencies.environment ?? (() => providerEnvironment())
    )();
    const manager = await resolvedManager(
      managerCommand,
      environment,
      dependencies,
    );
    if (!manager) return manualCapabilities(target, installMethod);

    return {
      providerId: "gemini",
      packageName: "@google/gemini-cli",
      installMethod,
      updateAvailability: "available",
      update:
        installMethod === "npm-global"
          ? {
              executable: manager,
              args: ["install", "-g", "@google/gemini-cli@latest"],
              environmentPathPrefix: npmManager?.pathPrefix,
              lockKey: "package-manager:npm-global",
              installMethod,
              label: "Update Gemini CLI with npm",
            }
          : {
              executable: manager,
              args: ["upgrade", "gemini-cli"],
              lockKey: "package-manager:homebrew",
              installMethod,
              label: "Update Gemini CLI with Homebrew",
            },
      instructionsUrl: INSTRUCTIONS_URLS.gemini,
    };
  }
  if (!target.installed || !target.executable) {
    return manualCapabilities(target, "unknown");
  }

  const installMethod = codexInstallMethodFromPath(target.executable);
  if (installMethod !== "npm-global" && installMethod !== "homebrew") {
    return manualCapabilities(target, installMethod);
  }
  const environment = await (
    dependencies.environment ?? (() => providerEnvironment())
  )();
  const platform = dependencies.platform ?? process.platform;
  const npmManager = installMethod === "npm-global"
    ? codexNpmManagerLocation(target.executable, platform)
    : null;
  if (installMethod === "npm-global" && !npmManager) {
    return manualCapabilities(target, installMethod);
  }
  const manager = await resolvedManager(
    npmManager?.command ?? "brew",
    environment,
    dependencies,
  );
  if (!manager) return manualCapabilities(target, installMethod);

  return {
    providerId: "codex",
    packageName: "@openai/codex",
    installMethod,
    updateAvailability: "available",
    update: installMethod === "npm-global"
      ? {
          executable: manager,
          args: ["install", "-g", "@openai/codex@latest"],
          environmentPathPrefix: npmManager?.pathPrefix,
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
