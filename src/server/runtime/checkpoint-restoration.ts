import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointSummary } from "../../shared/contracts";
import { assertCheckpointExists, createCheckpoint, restoreCheckpoint } from "../checkpoints";
import type { RuntimeStore } from "../database";
import { assertCheckpointPreservesIgnoredFiles } from "../git/checkpoint-ignored-paths";
import { getRepositoryStatus } from "../git/status";

export interface CheckpointRecoveryAttribution {
  turnId: string | null;
  label: string;
}

type RestorationStore = Pick<RuntimeStore, "conversationPath" | "addCheckpoint" | "checkpointCount">
  & Partial<Pick<RuntimeStore, "agentTurn" | "latestAgentTurnForConversation">>;

function recoveryTurnId(store: RestorationStore, conversationId: string, requested: string | null | undefined): string | null {
  const turn = requested === undefined ? store.latestAgentTurnForConversation?.(conversationId) ?? null
    : requested === null ? null : store.agentTurn?.(requested) ?? null;
  return turn && turn.conversationId === conversationId && turn.checkpointId !== null ? turn.id : null;
}

/** The caller must hold the checkout's work reservation for this entire operation. */
export async function restoreConversationCheckpoint(
  store: RestorationStore,
  checkpoint: CheckpointSummary,
  recoveryPersisted: (recovery: CheckpointSummary) => void,
  attribution?: CheckpointRecoveryAttribution,
): Promise<CheckpointSummary> {
  const repositoryPath = store.conversationPath(checkpoint.conversationId);
  const deadlineAt = Date.now() + 60_000;
  const storage = await mkdtemp(join(tmpdir(), "inertia-checkpoint-recovery-"));
  try {
    await assertCheckpointExists(repositoryPath, checkpoint.ref, { deadlineAt });
    await assertCheckpointPreservesIgnoredFiles(repositoryPath, checkpoint.ref, deadlineAt);
    const status = await getRepositoryStatus(repositoryPath, { deadlineAt });
    const recovery = await createCheckpoint(
      repositoryPath, storage, checkpoint.conversationId, { deadlineAt },
    );
    // Persist the recovery before the first destructive Git operation. If
    // persistence fails, preserve its Git ref and leave the worktree alone.
    const saved = store.addCheckpoint({
      conversationId: checkpoint.conversationId,
      turnId: recoveryTurnId(store, checkpoint.conversationId, attribution?.turnId),
      ref: recovery.ref,
      label: attribution?.label ?? "Before checkpoint restore",
      turnIndex: store.checkpointCount(checkpoint.conversationId) + 1,
      filesChanged: status.files.length,
      insertions: status.insertions,
      deletions: status.deletions,
    });
    recoveryPersisted(saved);
    await restoreCheckpoint(
      repositoryPath, checkpoint.ref, checkpoint.conversationId, { deadlineAt },
    );
    return saved;
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}
