import { isBackendPresetId, type ApiKeyBackendPresetId } from "@shared/backend-presets";
import type { BackendCompatibilityProbeResult } from "@shared/backend-probe";
import type {
  ModelBackendProfileView,
  ProviderId,
  ProviderInfo,
} from "@shared/contracts";
import {
  backendCompatibilityUsable,
  backendProfileRenewing,
  backendServerChecksBeforeSending,
  providerAccountKind,
  backendRouteKind,
  backendSourceProviderId,
} from "./backendRouteState";
import { providerStateLabel } from "./providerStatus";

export const BACKEND_SETTINGS_PROVIDER_ORDER = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "kimi",
  "antigravity",
] as const satisfies readonly ProviderId[];

export const BACKEND_SETTINGS_PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  kimi: "Kimi Code",
  antigravity: "Antigravity",
};

const GEMINI_API_KEY_PRESET = "gemini-api-key";

export const API_KEY_PRESET_FOR_PROVIDER: Readonly<Partial<Record<ProviderId, ApiKeyBackendPresetId>>> = {
  claude: "anthropic-api-key",
  codex: "openai-api-key",
  ...(isBackendPresetId(GEMINI_API_KEY_PRESET)
    ? { antigravity: GEMINI_API_KEY_PRESET as ApiKeyBackendPresetId }
    : {}),
};

export type BackendStateTone = "ready" | "attention" | "unavailable" | "idle" | "checking";

export interface BackendStateLabel {
  tone: BackendStateTone;
  label: string;
}

export function providerAccountState(
  provider: ProviderInfo | undefined,
  identityLabel: string | undefined,
): BackendStateLabel {
  if (!provider) return { tone: "idle", label: "Not detected" };
  if (provider.installState === "checking" || provider.authState === "checking") {
    return { tone: "checking", label: "Checking…" };
  }
  if (provider.installState === "not-installed") return { tone: "unavailable", label: "Not installed" };
  if (provider.installState !== "installed") {
    return { tone: "unavailable", label: providerStateLabel(provider) };
  }
  const signedIn = provider.authState === "authenticated" || provider.authState === "configured";
  if (signedIn && provider.canRun) {
    const name = identityLabel?.trim();
    const kind = providerAccountKind(provider);
    const signedInLabel = name ? `Signed in as ${name}` : "Signed in";
    return { tone: "ready", label: kind ? `${signedInLabel} · ${kind}` : signedInLabel };
  }
  if (provider.authState === "unauthenticated") return { tone: "attention", label: "Signed out" };
  if (provider.authState === "error") return { tone: "unavailable", label: "Connection issue" };
  if (provider.canRun) return { tone: "ready", label: "Ready" };
  return { tone: "attention", label: providerStateLabel(provider) };
}

export function keyProfilesForProvider(
  profiles: readonly ModelBackendProfileView[],
  providerId: ProviderId,
): ModelBackendProfileView[] {
  return profiles.filter((profile) =>
    backendRouteKind(profile) === "api-key"
    && backendSourceProviderId(profile) === providerId);
}

function probeResults(
  profile: Pick<ModelBackendProfileView, "latestProbe" | "models">,
): BackendCompatibilityProbeResult[] {
  const perModel = profile.models.flatMap(({ latestProbe }) => latestProbe ? [latestProbe] : []);
  if (perModel.length > 0) return perModel;
  return profile.latestProbe ? [profile.latestProbe] : [];
}

type ProbeProfile = Pick<ModelBackendProfileView, "latestProbe" | "models" | "protocol" | "routing">;

export function backendPrimaryModel(
  profile: Pick<ModelBackendProfileView, "models" | "routing">,
): ModelBackendProfileView["models"][number] | undefined {
  return profile.models.find(({ id }) => id === profile.routing.primaryModelId) ?? profile.models[0];
}

function toolsVerified(probe: BackendCompatibilityProbeResult): boolean {
  return probe.capabilities.some(({ id, state }) => id === "tools" && state === "verified");
}

function primaryProbeProblem(profile: ProbeProfile): string | null {
  const primary = backendPrimaryModel(profile);
  if (!primary) return "This route has no models.";
  const probe = primary.latestProbe;
  if (!probe) return `${primary.displayName}: not tested yet.`;
  if (probe.failure) return `${primary.displayName}: ${probe.failure.message}`;
  if (probe.compatibility === "unavailable") return `${primary.displayName}: this model is unavailable.`;
  if (profile.protocol === "openai-responses" && !toolsVerified(probe)) {
    return `${primary.displayName}: the model did not complete the tool check Codex needs.`;
  }
  if (
    primary.compatibility.reasonCode !== "profile-disabled"
    && (primary.compatibility.state === "unknown" || primary.compatibility.state === "unavailable")
  ) {
    return `${primary.displayName}: ${primary.compatibility.reason}`;
  }
  return null;
}

export function backendProbeFailure(profile: ProbeProfile): string | null {
  const primary = primaryProbeProblem(profile);
  if (primary && backendPrimaryModel(profile)?.latestProbe) return primary;
  const failed = profile.models.find(({ latestProbe }) => latestProbe?.failure);
  if (failed?.latestProbe?.failure) return `${failed.displayName}: ${failed.latestProbe.failure.message}`;
  const legacy = probeResults(profile).find(({ failure }) => failure);
  return legacy?.failure?.message ?? null;
}

export function backendProbePassed(profile: ProbeProfile): boolean {
  return primaryProbeProblem(profile) === null;
}

export function backendKeyCheckProblem(
  profile: Pick<ModelBackendProfileView, "authState" | "connectionState" | "latestProbe" | "models" | "protocol" | "routing" | "compatibility">,
): string | null {
  if (profile.authState === "missing") return "The key was not saved. Paste it again.";
  if (profile.authState === "unavailable") return "The key could not be read from the credential vault.";
  if (profile.latestProbe?.failure) return profile.latestProbe.failure.message;
  if (profile.connectionState === "failed") return backendProbeFailure(profile) ?? profile.compatibility.reason;
  return null;
}

export function backendCredentialRequired(
  profile: Pick<ModelBackendProfileView, "compatibility" | "models">,
): boolean {
  return profile.compatibility.reasonCode === "credential-required"
    || profile.models.some(({ compatibility }) => compatibility.reasonCode === "credential-required");
}

export function backendKeyState(
  profile: ModelBackendProfileView,
  busy: boolean,
): BackendStateLabel {
  if (profile.authState === "checking" || profile.connectionState === "testing" || busy) {
    return { tone: "checking", label: "Checking…" };
  }
  if (profile.authState === "missing" || backendCredentialRequired(profile)) {
    return { tone: "attention", label: "Needs a key" };
  }
  if (profile.authState === "unavailable") {
    return { tone: "unavailable", label: "Failed: the key could not be read from the credential vault" };
  }
  if (profile.connectionState === "failed") {
    const reason = backendProbeFailure(profile) ?? profile.compatibility.reason;
    return { tone: "unavailable", label: `Failed: ${reason}` };
  }
  if (!profile.enabled) return { tone: "idle", label: "Off" };
  if (backendProfileRenewing(profile)) return { tone: "checking", label: "Checking…" };
  const usable = profile.models.some(({ compatibility }) =>
    backendCompatibilityUsable(compatibility) || backendServerChecksBeforeSending(compatibility, profile))
    || backendCompatibilityUsable(profile.compatibility);
  if ((usable || profile.keyVerified === true) && profile.authState !== "harness-managed") {
    return { tone: "ready", label: "Ready" };
  }
  return { tone: "idle", label: "Not tested" };
}

export type ModelProbeOutcome = "passed" | "partial" | "failed" | "untested";

export function modelProbeOutcome(
  probe: BackendCompatibilityProbeResult | null,
): { outcome: ModelProbeOutcome; label: string } {
  if (!probe) return { outcome: "untested", label: "Not tested yet" };
  if (probe.failure) return { outcome: "failed", label: `Failed: ${probe.failure.message}` };
  if (probe.compatibility === "unavailable") return { outcome: "failed", label: "Failed: this model is unavailable" };
  if (probe.compatibility === "partially-compatible") {
    return { outcome: "partial", label: "Works with limits" };
  }
  return { outcome: "passed", label: "Works" };
}

export function backendEndpointLabel(profile: ModelBackendProfileView): string {
  if (profile.preset === "custom") {
    return profile.endpointHost ? `Custom · ${profile.endpointHost}` : "Custom";
  }
  return profile.endpointHost ?? "Built in";
}
