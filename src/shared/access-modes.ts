import type { AccessMode } from "./contracts";

export const SUPERVISED_ACCESS_UNAVAILABLE_REASON =
  "Antigravity can't pause for approval, so Supervised runs as Auto-accept edits: it edits files and refuses commands.";

export function providerCanSuperviseAccess(providerId: string): boolean {
  return providerId !== "antigravity";
}

export function effectiveAccessMode(providerId: string, accessMode: AccessMode): AccessMode {
  return accessMode === "supervised" && !providerCanSuperviseAccess(providerId) ? "auto-edit" : accessMode;
}

export function accessModeUnavailableReason(providerId: string, accessMode: AccessMode): string | null {
  return accessMode === "supervised" && !providerCanSuperviseAccess(providerId)
    ? SUPERVISED_ACCESS_UNAVAILABLE_REASON
    : null;
}
