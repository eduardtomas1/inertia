import type {
  BackendRouteKind,
  HarnessBackendCompatibility,
  ModelBackendProfileView,
  ProviderId,
  ProviderInfo,
} from "@shared/contracts";
import { providerIdForHarness } from "../../../shared/model-routing";

type CompatibilitySource = {
  compatibility: Pick<HarnessBackendCompatibility, "state" | "reason" | "reasonCode">;
  models?: readonly {
    id: string;
    compatibility?: Pick<HarnessBackendCompatibility, "state" | "reason" | "reasonCode">;
  }[];
};

export function backendModelCompatibility<Source extends CompatibilitySource>(
  profile: Source,
  modelId: string | null | undefined,
): Source["compatibility"] {
  if (!modelId) return profile.compatibility;
  const model = profile.models?.find(({ id }) => id === modelId);
  return (model?.compatibility as Source["compatibility"] | undefined) ?? profile.compatibility;
}

export function backendRouteKind(
  profile: Pick<ModelBackendProfileView, "authenticationMode"> & { routeKind?: BackendRouteKind },
): BackendRouteKind {
  if (profile.routeKind === "account" || profile.routeKind === "api-key") return profile.routeKind;
  return profile.authenticationMode === "harness-managed" ? "account" : "api-key";
}

export function backendSourceProviderId(
  profile: Pick<ModelBackendProfileView, "harnessId"> & { providerId?: ProviderId },
): ProviderId | null {
  return profile.providerId ?? providerIdForHarness(profile.harnessId);
}

const SERVER_CHECKED_REASON_CODES: ReadonlySet<string> = new Set(["probe-stale", "probe-required"]);
const KEY_READY_AUTH_STATES: ReadonlySet<string> = new Set(["configured", "not-required"]);

export function backendCompatibilityUsable(
  compatibility: Pick<HarnessBackendCompatibility, "state">,
): boolean {
  return compatibility.state !== "unknown" && compatibility.state !== "unavailable";
}

export function backendServerChecksBeforeSending(
  compatibility: Pick<HarnessBackendCompatibility, "state" | "reasonCode">,
  profile: Pick<ModelBackendProfileView, "authState">,
): boolean {
  return !backendCompatibilityUsable(compatibility)
    && SERVER_CHECKED_REASON_CODES.has(compatibility.reasonCode)
    && KEY_READY_AUTH_STATES.has(profile.authState);
}

export function backendProfileRenewing(
  profile: Pick<ModelBackendProfileView, "renewing">,
): boolean {
  return profile.renewing === true;
}

export function apiKeyRouteLabel(profileName: string): string {
  const name = profileName.trim();
  return /\bAPI key$/iu.test(name) ? name : `${name} · API key`;
}

export function providerInstalledForKeyRoutes(
  provider: Pick<ProviderInfo, "available" | "installState"> | undefined,
): boolean {
  return provider !== undefined
    && provider.available
    && provider.installState === "installed";
}

export function providerAccountKind(provider: object | undefined): string | null {
  const value = (provider as { accountKind?: unknown } | undefined)?.accountKind;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
