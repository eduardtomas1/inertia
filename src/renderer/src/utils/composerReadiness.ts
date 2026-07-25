import type {
  ModelBackendProfileView,
  ProviderInfo,
} from "@shared/contracts";

type ComposerBackendReadiness = Pick<
  ModelBackendProfileView,
  "authState" | "connectionState" | "enabled" | "preset"
> & {
  compatibility: Pick<ModelBackendProfileView["compatibility"], "state">;
};

const READY_BACKEND_AUTH_STATES = new Set([
  "configured",
  "harness-managed",
  "not-required",
]);
const READY_BACKEND_COMPATIBILITY_STATES = new Set([
  "partially-compatible",
  "verified",
]);

export function composerProviderReady(
  provider: ProviderInfo | undefined,
  profile: ComposerBackendReadiness | undefined,
): boolean {
  if (provider?.canRun !== true) return false;
  if (!profile || profile.preset === "native") return true;
  if (
    !profile.enabled
    || !READY_BACKEND_AUTH_STATES.has(profile.authState)
    || !READY_BACKEND_COMPATIBILITY_STATES.has(profile.compatibility.state)
  ) return false;

  if (profile.preset === "kimi-code") {
    return profile.connectionState !== "failed"
      && profile.connectionState !== "testing";
  }
  return profile.connectionState === "connected"
    || profile.connectionState === "limited";
}
