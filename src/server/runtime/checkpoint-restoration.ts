import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointSummary } from "../../shared/contracts";
import { createCheckpoint, restoreCheckpoint } from "../checkpoints";
import type { RuntimeStore } from "../database";
import { assertCheckpointPreservesIgnoredFiles } from "../git/checkpoint-ignored-paths";
import { getRepositoryStatus } from "../git/status";

/** The caller must hold the checkout's work reservation for this entire operation. */
export async function restoreConversationCheckpoint(
  store: Pick<RuntimeStore, "conversationPath" | "addCheckpoint" | "checkpointCount">,
  checkpoint: CheckpointSummary,
  recoveryPersisted: () => void,
): Promise<void> {
  const repositoryPath = store.conversationPath(checkpoint.conversationId);
  const deadlineAt = Date.now() + 60_000;
  const storage = await mkdtemp(join(tmpdir(), "inertia-checkpoint-recovery-"));
  try {
    await assertCheckpointPreservesIgnoredFiles(repositoryPath, checkpoint.ref, deadlineAt);
    const status = await getRepositoryStatus(repositoryPath, { deadlineAt });
    const recovery = await createCheckpoint(
      repositoryPath, storage, checkpoint.conversationId, { deadlineAt },
    );
    // Persist the recovery before the first destructive Git operation. If
    // persistence fails, preserve its Git ref and leave the worktree alone.
    store.addCheckpoint({
      conversationId: checkpoint.conversationId,
      ref: recovery.ref,
      label: "Before checkpoint restore",
      turnIndex: store.checkpointCount(checkpoint.conversationId) + 1,
      filesChanged: status.files.length,
      insertions: status.insertions,
      deletions: status.deletions,
    });
    recoveryPersisted();
    await restoreCheckpoint(
      repositoryPath, checkpoint.ref, checkpoint.conversationId, { deadlineAt },
    );
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}
