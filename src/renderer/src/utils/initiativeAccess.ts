import type { AccessMode, AppSnapshot, Initiative } from "@shared/contracts";
import { initiativeAccessCeilingMessage } from "@shared/access-modes";

/** An initiative in the snapshot, or null for no id or one that no longer exists. */
export function initiativeById(
  snapshot: Partial<Pick<AppSnapshot, "initiatives">> | null | undefined,
  initiativeId: string | null | undefined,
): Initiative | null {
  return initiativeId ? snapshot?.initiatives?.find(({ id }) => id === initiativeId) ?? null : null;
}

/** The access ceiling a chat's composer enforces, with the readable reason. */
export interface ComposerAccessCeiling {
  mode: AccessMode;
  reason: string;
}

export function composerAccessCeiling(
  initiative: Pick<Initiative, "name"> & { preferences: Pick<Initiative["preferences"], "accessCeiling"> } | null | undefined,
): ComposerAccessCeiling | undefined {
  const mode = initiative?.preferences.accessCeiling;
  return initiative && mode
    ? { mode, reason: initiativeAccessCeilingMessage(initiative.name, mode) }
    : undefined;
}
