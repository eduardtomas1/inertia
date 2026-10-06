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
import {
  classifyProviderInstallSource,
  providerInstallPackageName,
  type HomebrewLatestSource,
  type ProviderInstallSourceDependencies,
  type ProviderInstallUpdateAction,
} from "./maintenance-install-source";

export interface ProviderMaintenanceTarget {
  providerId: ProviderMaintenanceProviderId;
  executable: string | null;
  installedVersion: string | null;
  installed: boolean;
}

export type ProviderMaintenanceUpdateAction = ProviderInstallUpdateAction;

export interface ProviderMaintenanceCapabilities {
  providerId: ProviderMaintenanceProviderId;
  packageName: string | null;
  installMethod: ProviderMaintenanceInstallMethod;
  updateAvailability: ProviderMaintenanceUpdateAvailability;
  update: ProviderMaintenanceUpdateAction | null;
  instructionsUrl: string;
  message?: string;
  manualCommand?: string | null;
  homebrew?: HomebrewLatestSource;
}

export interface ProviderMaintenanceCapabilityDependencies
  extends Omit<ProviderInstallSourceDependencies, "executableCandidates"> {
  environment?: () => Promise<ProviderEnvironment>;
  executableCandidates?: typeof executableCandidates;
}

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

export async function resolveProviderMaintenanceCapabilities(
  target: ProviderMaintenanceTarget,
  dependencies: ProviderMaintenanceCapabilityDependencies = {},
): Promise<ProviderMaintenanceCapabilities> {
  const base = {
    providerId: target.providerId,
    packageName: providerInstallPackageName(target.providerId),
    instructionsUrl: INSTRUCTIONS_URLS[target.providerId],
  };
  if (!target.installed || !target.executable) {
    return {
      ...base,
      installMethod: "unknown",
      updateAvailability: "unavailable",
      update: null,
      manualCommand: null,
    };
  }
  const environment = await (
    dependencies.environment ?? (() => providerEnvironment())
  )();
  const source = await classifyProviderInstallSource({
    providerId: target.providerId,
    executable: target.executable,
    environment,
  }, dependencies);
  return {
    ...base,
    installMethod: source.installMethod,
    updateAvailability: source.update ? "available" : "instructions-only",
    update: source.update,
    manualCommand: source.manualCommand,
    ...(source.message ? { message: source.message } : {}),
    ...(source.homebrew ? { homebrew: source.homebrew } : {}),
  };
}
