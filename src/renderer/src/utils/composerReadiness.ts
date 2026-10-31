import type {
  ModelBackendProfileView,
  ModelSelection,
  ProviderInfo,
} from "@shared/contracts";
import { providerNativeBackendProfile } from "../../../shared/model-routing";
import { PROVIDER_MAINTENANCE_RECOVERY_MESSAGE } from "../../../shared/provider-maintenance";
import {
  backendCompatibilityUsable,
  backendModelCompatibility,
  backendProfileRenewing,
  backendServerChecksBeforeSending,
} from "./backendRouteState";

export type ComposerRouteRepair =
  | "install"
  | "connect"
  | "add-key"
  | "configure"
  | "probe"
  | "refresh";

export type ComposerRouteReadiness =
  | { ready: true }
  | {
      ready: false;
      transient: boolean;
      badge: string;
      title: string;
      detail: string;
      action: ComposerRouteRepair | null;
    };

type ComposerBackendReadiness = Pick<
  ModelBackendProfileView,
  | "authState"
  | "connectionState"
  | "displayName"
  | "enabled"
  | "preset"
  | "renewing"
> & {
  compatibility: Pick<
    ModelBackendProfileView["compatibility"],
    "reason" | "reasonCode" | "state"
  >;
  models?: readonly {
    id: string;
    compatibility?: Pick<
      ModelBackendProfileView["compatibility"],
      "reason" | "reasonCode" | "state"
    >;
  }[];
};

const SETTINGS_PLACE = "Settings → Agents → Accounts and API keys";

const READY_BACKEND_AUTH_STATES = new Set([
  "configured",
  "harness-managed",
  "not-required",
]);

function harnessLabel(harnessId: string): string {
  if (harnessId.startsWith("claude")) return "Claude harness";
  if (harnessId.startsWith("codex")) return "Codex harness";
  if (harnessId.startsWith("cursor")) return "Cursor harness";
  if (harnessId.startsWith("antigravity")) return "Antigravity";
  if (harnessId.startsWith("opencode")) return "OpenCode harness";
  return "Selected harness";
}

function unavailable(
  badge: string,
  title: string,
  detail: string,
  action: ComposerRouteRepair | null,
  transient = false,
): ComposerRouteReadiness {
  return { ready: false, transient, badge, title, detail, action };
}

function providerInstallReadiness(
  provider: ProviderInfo | undefined,
  selection: Pick<ModelSelection, "harnessId">,
): ComposerRouteReadiness {
  const harness = harnessLabel(selection.harnessId);
  if (!provider) {
    return unavailable(
      "Unavailable",
      `${harness} unavailable`,
      "Refresh agent status to check this selected route.",
      "refresh",
    );
  }
  if (provider.installState === "checking") {
    return unavailable(
      "Checking",
      `Checking ${harness.toLocaleLowerCase("en-US")}`,
      provider.statusMessage ?? "Checking the local CLI…",
      null,
      true,
    );
  }
  if (provider.installState === "not-installed") {
    return unavailable(
      "CLI missing",
      `${harness} CLI not found`,
      provider.statusMessage ?? "Install the selected harness CLI to use this route.",
      "install",
    );
  }
  if (provider.installState === "recovery-required") {
    return unavailable(
      "Recovery required",
      `${harness} needs recovery`,
      provider.statusMessage ?? PROVIDER_MAINTENANCE_RECOVERY_MESSAGE,
      null,
    );
  }
  if (provider.installState === "unresponsive") {
    return unavailable(
      "Unavailable",
      `${harness} is not responding`,
      provider.statusMessage ?? "Refresh agent status to check again.",
      "refresh",
    );
  }
  if (
    provider.installState === "error"
    || !provider.available
    || !provider.executable
  ) {
    return unavailable(
      "Unavailable",
      `${harness} could not start`,
      provider.statusMessage ?? "Refresh after repairing the selected harness CLI.",
      "refresh",
    );
  }
  if (provider.updateRequired) {
    return unavailable(
      "Update needed",
      `${provider.label} cannot run this route`,
      provider.statusMessage ?? `Update ${provider.label}, then refresh agent status.`,
      "refresh",
    );
  }
  return { ready: true };
}

function nativeReadiness(
  provider: ProviderInfo | undefined,
  selection: Pick<ModelSelection, "harnessId">,
): ComposerRouteReadiness {
  if (provider?.canRun === true) return { ready: true };
  const installed = providerInstallReadiness(provider, selection);
  if (!installed.ready) return installed;
  if (!provider) return unavailable(
    "Unavailable",
    `${harnessLabel(selection.harnessId)} unavailable`,
    "Refresh agent status to check this selected route.",
    "refresh",
  );
  if (provider.authState === "checking") {
    return unavailable(
      "Checking",
      `Checking ${provider.label}`,
      provider.statusMessage ?? "Checking the local account…",
      null,
      true,
    );
  }
  if (provider.authState === "error") {
    return unavailable(
      "Connection issue",
      `${provider.label} connection check failed`,
      provider.statusMessage ?? "Refresh the selected agent connection.",
      "refresh",
    );
  }
  if (
    provider.id === "antigravity"
    && provider.authState === "unknown"
  ) {
    return unavailable(
      "Update needed",
      `${provider.label} cannot run this route`,
      provider.statusMessage ?? "Run 'agy update', then refresh agent status.",
      "refresh",
    );
  }
  if (
    provider.authState === "unauthenticated"
    || provider.authState === "unknown"
  ) {
    return unavailable(
      "Sign in",
      `${provider.label} needs a connection`,
      provider.statusMessage ?? `Connect ${provider.label} to use its native backend.`,
      "connect",
    );
  }
  return unavailable(
    "Update needed",
    `${provider.label} cannot run this route`,
    provider.statusMessage ?? "Refresh after updating the selected agent CLI.",
    "refresh",
  );
}

function externalReadiness(
  provider: ProviderInfo | undefined,
  profile: ComposerBackendReadiness | undefined,
  selection: Pick<
    ModelSelection,
    "backendProfileDisplayName" | "harnessId"
  > & Partial<Pick<ModelSelection, "modelId">>,
): ComposerRouteReadiness {
  const backend = profile?.displayName ?? selection.backendProfileDisplayName;
  if (!profile) {
    return unavailable(
      "Unavailable",
      `${backend} is unavailable`,
      "The selected backend profile is not available in this runtime.",
      "refresh",
    );
  }
  if (!profile.enabled) {
    return unavailable(
      "Disabled",
      `${backend} is disabled`,
      `Turn it on in ${SETTINGS_PLACE}.`,
      "configure",
    );
  }

  const installed = providerInstallReadiness(provider, selection);
  if (!installed.ready) return installed;

  const credentialCompatibility = backendModelCompatibility(profile, selection.modelId);
  if (
    credentialCompatibility.reasonCode === "credential-required"
    || profile.compatibility.reasonCode === "credential-required"
  ) {
    return unavailable(
      "Key missing",
      `${backend} needs a key`,
      credentialCompatibility.reasonCode === "credential-required"
        ? credentialCompatibility.reason
        : profile.compatibility.reason,
      "add-key",
    );
  }

  if (profile.authState === "checking") {
    return unavailable(
      "Checking",
      `Checking ${backend}`,
      "Checking the backend credential in secure storage…",
      null,
      true,
    );
  }
  if (!READY_BACKEND_AUTH_STATES.has(profile.authState)) {
    return unavailable(
      "Key missing",
      `${backend} needs a key`,
      profile.authState === "unavailable"
        ? "The backend credential could not be read from secure storage."
        : `Add the API key in ${SETTINGS_PLACE}.`,
      "add-key",
    );
  }

  // The Kimi preset has a documented Claude-compatible route. Its live probe
  // is optional, and native Claude account state is not part of this route.
  if (profile.preset === "kimi-code") return { ready: true };

  const compatibility = backendModelCompatibility(profile, selection.modelId);
  const checking = unavailable(
    "Checking",
    "Checking the backend…",
    `Inertia is checking that ${backend} still answers. This usually takes a few seconds.`,
    null,
    true,
  );
  if (profile.connectionState === "testing") return checking;
  if (backendCompatibilityUsable(compatibility)) return { ready: true };
  if (backendServerChecksBeforeSending(compatibility, profile)) return { ready: true };
  if (backendProfileRenewing(profile)) return checking;
  const cannotBeProbed = (
    compatibility.reasonCode === "protocol-mismatch"
    || compatibility.reasonCode === "cursor-managed"
    || compatibility.reasonCode === "opencode-native-catalog"
  );
  if (cannotBeProbed) {
    return unavailable(
      "Unavailable",
      `${backend} is incompatible`,
      compatibility.reason,
      null,
    );
  }
  return unavailable(
    "Test failed",
    `${backend} failed its connection test`,
    compatibility.reason,
    "probe",
  );
}

export function composerRouteReadiness(input: {
  provider: ProviderInfo | undefined;
  profile: ComposerBackendReadiness | undefined;
  selection: Pick<
    ModelSelection,
    | "backendProfileDisplayName"
    | "backendProfileId"
    | "harnessId"
  > & Partial<Pick<ModelSelection, "modelId">>;
}): ComposerRouteReadiness {
  const nativeBackendId = input.provider
    ? providerNativeBackendProfile(input.provider.id).id
    : null;
  const native = nativeBackendId === input.selection.backendProfileId;
  return native
    ? nativeReadiness(input.provider, input.selection)
    : externalReadiness(input.provider, input.profile, input.selection);
}

export function composerProviderReady(
  provider: ProviderInfo | undefined,
  profile: ComposerBackendReadiness | undefined,
  modelId?: string,
): boolean {
  if (!profile || profile.preset === "native") {
    return provider?.canRun === true;
  }
  if (
    !profile.enabled
    || !READY_BACKEND_AUTH_STATES.has(profile.authState)
  ) return false;
  if (
    !provider
    || provider.installState !== "installed"
    || !provider.available
    || !provider.executable
    || provider.updateRequired
  ) return false;
  if (profile.preset === "kimi-code") return true;
  const compatibility = backendModelCompatibility(profile, modelId);
  return profile.connectionState !== "testing"
    && (
      backendCompatibilityUsable(compatibility)
      || backendServerChecksBeforeSending(compatibility, profile)
    );
}
