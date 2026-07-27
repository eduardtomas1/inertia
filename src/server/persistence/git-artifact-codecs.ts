import type {
  TurnGitArtifact,
  TurnGitArtifactFile,
} from "../../shared/contracts";
import type { TurnGitArtifactRow } from "./rows";
import type { StoredTurnGitArtifact } from "./types";

function parseTurnGitArtifactFiles(value: string): TurnGitArtifactFile[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const file = item as Partial<TurnGitArtifactFile>;
      if (
        typeof file.path !== "string"
        || file.path.length === 0
        || file.path.length > 4_096
        || typeof file.status !== "string"
        || !Number.isSafeInteger(file.insertions)
        || (file.insertions ?? -1) < 0
        || !Number.isSafeInteger(file.deletions)
        || (file.deletions ?? -1) < 0
      ) return [];
      return [{
        path: file.path,
        previousPath: typeof file.previousPath === "string"
          ? file.previousPath
          : null,
        status: file.status.slice(0, 40),
        insertions: file.insertions!,
        deletions: file.deletions!,
        binary: file.binary === true,
        untracked: file.untracked === true,
        staged: file.staged === true,
        unstaged: file.unstaged === true,
        indexStatus: typeof file.indexStatus === "string"
          ? file.indexStatus.slice(0, 4)
          : ".",
        worktreeStatus: typeof file.worktreeStatus === "string"
          ? file.worktreeStatus.slice(0, 4)
          : ".",
      }];
    }).slice(0, 200);
  } catch {
    return [];
  }
}

export function turnGitArtifactFromRow(
  row: TurnGitArtifactRow,
): TurnGitArtifact {
  return {
    id: row.id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    repositoryIdentity: row.repository_identity,
    worktreeIdentity: row.worktree_identity,
    branch: row.branch,
    beforeCheckpointId: row.before_checkpoint_id,
    beforeFingerprint: row.before_fingerprint,
    afterFingerprint: row.after_fingerprint,
    files: parseTurnGitArtifactFiles(row.files_json),
    insertions: row.insertions,
    deletions: row.deletions,
    status: row.status,
    completeness: row.completeness,
    patchState: row.patch_state,
    patchDigest: row.patch_digest,
    capturedAt: row.captured_at,
    terminalAssistantMessageId: row.terminal_assistant_message_id,
    failureReason: row.failure_reason,
    absenceReason: row.absence_reason === "not-repository"
      ? row.absence_reason
      : null,
  };
}

export function storedTurnGitArtifactFromRow(
  row: TurnGitArtifactRow,
): StoredTurnGitArtifact {
  return {
    ...turnGitArtifactFromRow(row),
    beforeRef: row.before_ref,
    afterRef: row.after_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function optionalSha256(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return value;
}

export function optionalArtifactRef(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (
    value.length > 500
    || !/^refs\/inertia\/checkpoints\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function normalizeTurnGitArtifactFiles(
  files: readonly TurnGitArtifactFile[],
): TurnGitArtifactFile[] {
  if (files.length > 200) {
    throw new Error("A turn Git artifact can contain at most 200 files.");
  }
  return files.map((file) => {
    const path = file.path.trim();
    const previousPath = file.previousPath?.trim() || null;
    if (
      path.length === 0
      || path.length > 4_096
      || path.startsWith("/")
      || path.includes("\0")
      || path.split("/").includes("..")
      || (previousPath !== null && (
        previousPath.length > 4_096
        || previousPath.startsWith("/")
        || previousPath.includes("\0")
        || previousPath.split("/").includes("..")
      ))
    ) {
      throw new Error(
        "A turn Git artifact contains an invalid repository-relative path.",
      );
    }
    if (
      !Number.isSafeInteger(file.insertions)
      || file.insertions < 0
      || !Number.isSafeInteger(file.deletions)
      || file.deletions < 0
    ) {
      throw new Error(
        "Turn Git artifact statistics must be non-negative integers.",
      );
    }
    return {
      ...file,
      path,
      previousPath,
      status: file.status.trim().slice(0, 40) || "unknown",
      indexStatus: file.indexStatus.slice(0, 4),
      worktreeStatus: file.worktreeStatus.slice(0, 4),
    };
  });
}
