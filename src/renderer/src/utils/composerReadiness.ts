import type {
  ModelBackendProfileView,
  ModelSelection,
  ProviderInfo,
} from "@shared/contracts";
import { nativeBackendProfile } from "../../../shared/model-routing";

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
> & {
  compatibility: Pick<
    ModelBackendProfileView["compatibility"],
    "reason" | "reasonCode" | "state"
  >;
};

const READY_BACKEND_AUTH_STATES = new Set([
  "configured",
  "harness-managed",
  "not-required",
]);

function harnessLabel(harnessId: string): string {
  if (harnessId.startsWith("claude")) return "Claude harness";
  if (harnessId.startsWith("codex")) return "Codex harness";
  if (harnessId.startsWith("cursor")) return "Cursor harness";
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
  >,
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
      "Enable this profile in Model Backends, then probe it if required.",
      "configure",
    );
  }

  const installed = providerInstallReadiness(provider, selection);
  if (!installed.ready) return installed;

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
        : "Add the backend credential in Model Backends.",
      "add-key",
    );
  }

  // The Kimi preset has a documented Claude-compatible route. Its live probe
  // is optional, and native Claude account state is not part of this route.
  if (profile.preset === "kimi-code") return { ready: true };

  if (profile.connectionState === "testing") {
    return unavailable(
      "Probing",
      `Probing ${backend}`,
      "Testing the selected endpoint and model…",
      null,
      true,
    );
  }
  if (
    profile.compatibility.state === "unknown"
    || profile.compatibility.state === "unavailable"
  ) {
    const cannotBeProbed = (
      profile.compatibility.reasonCode === "protocol-mismatch"
      || profile.compatibility.reasonCode === "cursor-managed"
      || profile.compatibility.reasonCode === "opencode-native-catalog"
    );
    return unavailable(
      cannotBeProbed ? "Unavailable" : "Probe needed",
      cannotBeProbed
        ? `${backend} is incompatible`
        : `${backend} needs a probe`,
      profile.compatibility.reason,
      cannotBeProbed ? null : "probe",
    );
  }
  return { ready: true };
}

export function composerRouteReadiness(input: {
  provider: ProviderInfo | undefined;
  profile: ComposerBackendReadiness | undefined;
  selection: Pick<
    ModelSelection,
    | "backendProfileDisplayName"
    | "backendProfileId"
    | "harnessId"
  >;
}): ComposerRouteReadiness {
  const nativeBackendId = input.provider
    ? nativeBackendProfile(input.provider.id).id
    : null;
  const native = nativeBackendId === input.selection.backendProfileId;
  return native
    ? nativeReadiness(input.provider, input.selection)
    : externalReadiness(input.provider, input.profile, input.selection);
}

export function composerProviderReady(
  provider: ProviderInfo | undefined,
  profile: ComposerBackendReadiness | undefined,
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
  ) return false;
  if (profile.preset === "kimi-code") return true;
  return profile.connectionState !== "testing"
    && profile.compatibility.state !== "unknown"
    && profile.compatibility.state !== "unavailable";
}
