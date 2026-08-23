export interface RuntimeDatabaseStartupRecoveryReport {
  checkedAt: string;
  outcome: "healthy" | "first-launch" | "restored" | "created-empty";
  trigger: "none" | "primary-missing" | "primary-corrupt";
  restoredBackup: string | null;
  preservedCorruptPrimary: boolean;
  preservedDatabaseFamilyMembers: number;
  invalidBackupsSkipped: number;
  unsupportedBackupsSkipped: number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRuntimeDatabaseStartupRecovery(
  value: unknown,
): RuntimeDatabaseStartupRecoveryReport | null {
  if (!plainObject(value) || Object.keys(value).length !== 8) return null;
  if (
    typeof value.checkedAt !== "string"
    || value.checkedAt.length > 64
    || !Number.isFinite(Date.parse(value.checkedAt))
    || (
      value.outcome !== "healthy"
      && value.outcome !== "first-launch"
      && value.outcome !== "restored"
      && value.outcome !== "created-empty"
    )
    || (
      value.trigger !== "none"
      && value.trigger !== "primary-missing"
      && value.trigger !== "primary-corrupt"
    )
    || (
      value.restoredBackup !== null
      && (
        typeof value.restoredBackup !== "string"
        || !/^[A-Za-z0-9_.-]{1,200}$/u.test(value.restoredBackup)
      )
    )
    || typeof value.preservedCorruptPrimary !== "boolean"
    || typeof value.preservedDatabaseFamilyMembers !== "number"
    || !Number.isSafeInteger(value.preservedDatabaseFamilyMembers)
    || value.preservedDatabaseFamilyMembers < 0
    || value.preservedDatabaseFamilyMembers > 3
    || typeof value.invalidBackupsSkipped !== "number"
    || !Number.isSafeInteger(value.invalidBackupsSkipped)
    || value.invalidBackupsSkipped < 0
    || typeof value.unsupportedBackupsSkipped !== "number"
    || !Number.isSafeInteger(value.unsupportedBackupsSkipped)
    || value.unsupportedBackupsSkipped < 0
  ) return null;
  if (
    (
      (value.outcome === "healthy" || value.outcome === "first-launch")
      && (
        value.trigger !== "none"
        || value.restoredBackup !== null
        || value.preservedCorruptPrimary
        || value.preservedDatabaseFamilyMembers !== 0
        || value.invalidBackupsSkipped !== 0
        || value.unsupportedBackupsSkipped !== 0
      )
    )
    || (
      value.outcome === "restored"
      && (value.trigger === "none" || value.restoredBackup === null)
    )
    || (
      value.outcome === "created-empty"
      && (value.trigger === "none" || value.restoredBackup !== null)
    )
    || (
      value.preservedCorruptPrimary
      && (
        value.trigger !== "primary-corrupt"
        || value.preservedDatabaseFamilyMembers < 1
      )
    )
  ) return null;
  return {
    checkedAt: value.checkedAt,
    outcome: value.outcome,
    trigger: value.trigger,
    restoredBackup: value.restoredBackup,
    preservedCorruptPrimary: value.preservedCorruptPrimary,
    preservedDatabaseFamilyMembers: value.preservedDatabaseFamilyMembers,
    invalidBackupsSkipped: value.invalidBackupsSkipped,
    unsupportedBackupsSkipped: value.unsupportedBackupsSkipped,
  };
}
