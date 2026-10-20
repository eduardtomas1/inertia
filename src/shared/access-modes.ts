/** Every access mode, from the most to the least supervised. */
export const ACCESS_MODES = ["supervised", "auto-edit", "full"] as const;

/** How much an agent may do without asking; contracts re-export this type. */
export type AccessMode = (typeof ACCESS_MODES)[number];

/** The names the composer's access chooser shows. */
export const ACCESS_MODE_LABELS: Readonly<Record<AccessMode, string>> = {
  supervised: "Supervised",
  "auto-edit": "Auto-accept edits",
  full: "Full access",
};

/** Orders access modes: a higher rank allows the agent more. */
export function accessModeRank(mode: AccessMode): number {
  return ACCESS_MODES.indexOf(mode);
}

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

/** Lowers `mode` to `ceiling` when it exceeds it; never raises it. */
export function clampAccessMode(mode: AccessMode, ceiling: AccessMode | null | undefined): AccessMode {
  return ceiling && accessModeRank(mode) > accessModeRank(ceiling) ? ceiling : mode;
}

/** True when `mode` allows more than the ceiling. */
export function exceedsAccessCeiling(mode: AccessMode, ceiling: AccessMode | null | undefined): boolean {
  return clampAccessMode(mode, ceiling) !== mode;
}

/** The access modes above a ceiling, which member chats cannot use. */
export function accessModesAboveCeiling(ceiling: AccessMode): AccessMode[] {
  return ACCESS_MODES.filter((mode) => accessModeRank(mode) > accessModeRank(ceiling));
}

/** The readable refusal for access above an initiative's ceiling. */
export function initiativeAccessCeilingMessage(name: string, ceiling: AccessMode): string {
  return `“${name}” limits chats to ${ACCESS_MODE_LABELS[ceiling]}.`;
}

/** Added to the limit's message when the provider itself cannot stay within it. */
export const UNSUPERVISED_PROVIDER_LIMIT_REASON = "Antigravity cannot run supervised.";

/**
 * True when a turn on `providerId` would still run above the limit once its
 * access is lowered to it. The access the provider actually runs with is
 * compared, so Antigravity, which runs Supervised as Auto-accept edits,
 * exceeds a Supervised limit.
 */
export function providerExceedsAccessLimit(
  providerId: string,
  mode: AccessMode,
  limit: AccessMode | null | undefined,
): boolean {
  return exceedsAccessCeiling(effectiveAccessMode(providerId, clampAccessMode(mode, limit)), limit);
}
