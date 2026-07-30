import { randomUUID } from "node:crypto";

import type {
  AgentTurn,
  CheckpointSummary,
  TurnGitArtifact,
} from "../../shared/contracts";
import {
  optionalTurnString,
  requiredTurnString,
  requireTimestamp,
} from "./codecs";
import { RecordNotFoundError } from "./errors";
import {
  normalizeTurnGitArtifactFiles,
  optionalArtifactRef,
  optionalSha256,
  storedTurnGitArtifactFromRow,
  turnGitArtifactFromRow,
} from "./git-artifact-codecs";
import type {
  MessageRow,
  TurnGitArtifactRow,
} from "./rows";
import type {
  CompleteTurnGitArtifactInput,
  CreateTurnGitArtifactInput,
  StoredTurnGitArtifact,
} from "./types";
import type Database from "better-sqlite3";

interface GitArtifactPersistenceContext {
  agentTurn(turnId: string): AgentTurn;
  checkpoint(checkpointId: string): CheckpointSummary;
  database: Database.Database;
}

export class GitArtifactRepository {
  constructor(private readonly context: GitArtifactPersistenceContext) {}

  create(input: CreateTurnGitArtifactInput): StoredTurnGitArtifact {
    const turn = this.context.agentTurn(input.turnId);
    const createdAt = requireTimestamp(
      input.createdAt ?? new Date().toISOString(),
      "Artifact creation time",
    );
    const beforeCheckpointId = optionalTurnString(
      input.beforeCheckpointId,
      "Artifact checkpoint ID",
      200,
    );
    if (beforeCheckpointId) {
      const checkpoint = this.context.checkpoint(beforeCheckpointId);
      if (checkpoint.conversationId !== turn.conversationId) {
        throw new Error("The artifact checkpoint belongs to a different conversation.");
      }
      if (checkpoint.turnId !== null && checkpoint.turnId !== turn.id) {
        throw new Error("The artifact checkpoint belongs to a different turn.");
      }
    }
    const status = input.status ?? "pending";
    if (!["pending", "ready", "partial", "unavailable", "failed"].includes(status)) {
      throw new Error("The turn Git artifact status is invalid.");
    }
    const artifact: StoredTurnGitArtifact = {
      id: requiredTurnString(input.id ?? randomUUID(), "Artifact ID", 200),
      turnId: turn.id,
      conversationId: turn.conversationId,
      runId: turn.runId,
      repositoryIdentity: optionalSha256(input.repositoryIdentity, "Repository identity"),
      worktreeIdentity: optionalSha256(input.worktreeIdentity, "Worktree identity"),
      branch: optionalTurnString(input.branch, "Artifact branch", 300),
      beforeCheckpointId,
      beforeRef: optionalArtifactRef(input.beforeRef, "Artifact before reference"),
      afterRef: null,
      beforeFingerprint: optionalSha256(input.beforeFingerprint, "Artifact before fingerprint"),
      afterFingerprint: null,
      files: [],
      insertions: 0,
      deletions: 0,
      status,
      completeness: input.completeness ?? (status === "unavailable" ? "unavailable" : "partial"),
      patchState: "none",
      patchDigest: null,
      capturedAt: null,
      terminalAssistantMessageId: null,
      failureReason: optionalTurnString(input.failureReason, "Artifact failure reason", 1_000),
      absenceReason: input.absenceReason === "not-repository"
        ? input.absenceReason
        : null,
      createdAt,
      updatedAt: createdAt,
    };
    this.context.database.prepare(`
      INSERT INTO turn_git_artifacts (
        id, turn_id, conversation_id, run_id, repository_identity, worktree_identity,
        branch, before_checkpoint_id, before_ref, after_ref, before_fingerprint,
        after_fingerprint, files_json, insertions, deletions, status, completeness,
        patch_state, patch_digest, captured_at, terminal_assistant_message_id,
        failure_reason, absence_reason, created_at, updated_at
      ) VALUES (
        @id, @turnId, @conversationId, @runId, @repositoryIdentity, @worktreeIdentity,
        @branch, @beforeCheckpointId, @beforeRef, NULL, @beforeFingerprint,
        NULL, '[]', 0, 0, @status, @completeness,
        'none', NULL, NULL, NULL, @failureReason, @absenceReason, @createdAt, @updatedAt
      )
    `).run(artifact);
    return artifact;
  }

  complete(
    turnId: string,
    input: CompleteTurnGitArtifactInput,
  ): StoredTurnGitArtifact {
    const row = this.context.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    if (!row) throw new RecordNotFoundError("Turn Git artifact not found.");
    const current = storedTurnGitArtifactFromRow(row);
    const updatedAt = requireTimestamp(
      input.updatedAt ?? new Date().toISOString(),
      "Artifact update time",
    );
    if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
      throw new Error("Artifact update time cannot move backwards.");
    }
    const files = input.files === undefined
      ? current.files
      : normalizeTurnGitArtifactFiles(input.files);
    const filesJson = JSON.stringify(files);
    if (filesJson.length > 262_144) {
      throw new Error("Turn Git artifact file metadata is too large.");
    }
    const insertions = input.insertions ?? current.insertions;
    const deletions = input.deletions ?? current.deletions;
    if (
      !Number.isSafeInteger(insertions)
      || insertions < 0
      || !Number.isSafeInteger(deletions)
      || deletions < 0
    ) {
      throw new Error("Artifact statistics must be non-negative integers.");
    }
    const afterRef = input.afterRef === undefined
      ? current.afterRef
      : optionalArtifactRef(input.afterRef, "Artifact after reference");
    const afterFingerprint = input.afterFingerprint === undefined
      ? current.afterFingerprint
      : optionalSha256(input.afterFingerprint, "Artifact after fingerprint");
    const patchDigest = input.patchDigest === undefined
      ? current.patchDigest
      : optionalSha256(input.patchDigest, "Artifact patch digest");
    const capturedAt = input.capturedAt === undefined
      ? current.capturedAt
      : input.capturedAt === null
        ? null
        : requireTimestamp(input.capturedAt, "Artifact capture time");
    const terminalAssistantMessageId = input.terminalAssistantMessageId === undefined
      ? current.terminalAssistantMessageId
      : optionalTurnString(input.terminalAssistantMessageId, "Artifact terminal message ID", 200);
    if (
      terminalAssistantMessageId
      && terminalAssistantMessageId !== this.context.agentTurn(turnId).terminalAssistantMessageId
    ) {
      const message = this.context.database.prepare("SELECT * FROM messages WHERE id = ?")
        .get(terminalAssistantMessageId) as MessageRow | undefined;
      if (!message || message.turn_id !== turnId || message.role !== "assistant") {
        throw new Error("The artifact terminal message does not belong to this turn.");
      }
    }
    const failureReason = input.failureReason === undefined
      ? current.failureReason
      : optionalTurnString(input.failureReason, "Artifact failure reason", 1_000);
    const absenceReason = input.absenceReason === undefined
      ? current.absenceReason ?? null
      : input.absenceReason === "not-repository"
        ? input.absenceReason
        : null;
    this.context.database.prepare(`
      UPDATE turn_git_artifacts SET
        after_ref = @afterRef,
        after_fingerprint = @afterFingerprint,
        files_json = @filesJson,
        insertions = @insertions,
        deletions = @deletions,
        status = @status,
        completeness = @completeness,
        patch_state = @patchState,
        patch_digest = @patchDigest,
        captured_at = @capturedAt,
        terminal_assistant_message_id = @terminalAssistantMessageId,
        failure_reason = @failureReason,
        absence_reason = @absenceReason,
        updated_at = @updatedAt
      WHERE turn_id = @turnId
    `).run({
      turnId,
      afterRef,
      afterFingerprint,
      filesJson,
      insertions,
      deletions,
      status: input.status,
      completeness: input.completeness,
      patchState: input.patchState ?? current.patchState,
      patchDigest,
      capturedAt,
      terminalAssistantMessageId,
      failureReason,
      absenceReason,
      updatedAt,
    });
    return this.storage(turnId);
  }

  get(turnId: string): TurnGitArtifact | null {
    const row = this.context.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    return row ? turnGitArtifactFromRow(row) : null;
  }

  storage(turnId: string): StoredTurnGitArtifact {
    const row = this.context.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    if (!row) throw new RecordNotFoundError("Turn Git artifact not found.");
    return storedTurnGitArtifactFromRow(row);
  }

  pending(): StoredTurnGitArtifact[] {
    return (this.context.database.prepare(`
      SELECT * FROM turn_git_artifacts
      WHERE status = 'pending'
      ORDER BY created_at ASC, id ASC
    `).all() as TurnGitArtifactRow[]).map(storedTurnGitArtifactFromRow);
  }

  revision(): string {
    return JSON.stringify(this.context.database.prepare(`
      SELECT
        id,
        status,
        completeness,
        patch_state,
        patch_digest,
        captured_at,
        updated_at
      FROM turn_git_artifacts
      ORDER BY id ASC
    `).all());
  }

  patchDigests(): Set<string> {
    return new Set((this.context.database.prepare(`
      SELECT DISTINCT patch_digest AS digest
      FROM turn_git_artifacts
      WHERE patch_digest IS NOT NULL AND patch_state IN ('available', 'truncated')
    `).all() as Array<{ digest: string }>).map(({ digest }) => digest));
  }

  expirePatch(digest: string): void {
    const validated = optionalSha256(digest, "Artifact patch digest");
    this.context.database.prepare(`
      UPDATE turn_git_artifacts
      SET patch_state = 'expired', updated_at = ?
      WHERE patch_digest = ? AND patch_state IN ('available', 'truncated')
    `).run(new Date().toISOString(), validated);
  }
}
