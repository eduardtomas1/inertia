import { lstat, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AgentTurn, CheckpointSummary } from "../../shared/contracts";
import type { RollbackFiles } from "../../shared/orchestration-history";
import { CheckpointError, createCheckpoint, deleteCheckpoint } from "../checkpoints";
import type { RuntimeStore } from "../database";
import { captureGitArtifactState, compareGitSnapshots } from "../git/artifacts";
import { MAX_DIFF_FILES } from "../git/constants";
import { canonicalDirectoryPath, isContained, repositoryRoot, validatedEntryPaths } from "../git/paths";
import { GitError } from "../git/types";
import { restoreConversationCheckpoint } from "./checkpoint-restoration";
import { claimCheckoutForRestore, type CheckoutRestoreActivity } from "./checkout-restore-fence";

export type RestoreConversationCheckpoint = typeof restoreConversationCheckpoint;

export interface RollbackFileRestoreInput {
  conversationId: string;
  rolledBackTurnIds: readonly string[];
  recoveryTurnId: string | null;
  beginRestore(): void;
  activity: CheckoutRestoreActivity;
  restoreCheckpoint?: RestoreConversationCheckpoint;
}

export type RollbackFileRestoreResult = RollbackFiles & { recoveryCheckpointId: string | null };

interface RecordedScope {
  target: { turn: AgentTurn; beforeRef: string; createdAt: string };
  finalRef: string | null;
  repositoryIdentity: string;
  worktreeIdentity: string;
  paths: Set<string>;
  additions: Set<string>;
}

const UNRECORDED = "Inertia could not establish every file the rolled-back turns changed, so files were left unchanged.";
const UNOWNED = "Inertia could not confirm that this chat owns its workspace, so files were left unchanged.";
const SHARED = "Another chat worked in this workspace after the rolled-back turns started, so files were left unchanged. Restore them from a checkpoint if needed.";
const BUSY = "Another chat, terminal or task is working in this workspace or a folder that overlaps it, so files were left unchanged. Stop it, then restore them from a checkpoint if needed.";

function outcome(value: RollbackFiles["outcome"], message: string, recoveryCheckpointId: string | null = null): RollbackFileRestoreResult {
  return { outcome: value, message: message.slice(0, 1_000), recoveryCheckpointId };
}

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function failed(error: unknown, recovery: CheckpointSummary | null): RollbackFileRestoreResult {
  const reason = error instanceof CheckpointError || error instanceof GitError ? error.message : "Inertia could not restore the files.";
  return recovery
    ? outcome("failed", `File restore failed after Inertia saved a recovery checkpoint. Review the workspace. ${reason}`, recovery.id)
    : outcome("failed", `Files were left unchanged. ${reason}`);
}

function recordedScope(store: RuntimeStore, turnIds: readonly string[]): RecordedScope | RollbackFileRestoreResult | null {
  let scope: RecordedScope | null = null;
  let finalRef: string | null = null;
  for (const turnId of turnIds) {
    const turn = store.agentTurn(turnId);
    const artifact = store.turnGitArtifact(turnId);
    if (!artifact) {
      if (turn.startedAt === null) continue;
      return outcome("refused", UNRECORDED);
    }
    if (artifact.absenceReason === "not-repository") continue;
    if (artifact.status !== "ready" || artifact.completeness !== "complete") return outcome("refused", UNRECORDED);
    const { beforeRef, afterRef, createdAt } = store.turnGitArtifactStorage(turnId);
    finalRef = afterRef;
    if (artifact.files.length === 0) continue;
    if (!beforeRef || !artifact.repositoryIdentity || !artifact.worktreeIdentity) return outcome("refused", UNRECORDED);
    scope ??= { target: { turn, beforeRef, createdAt }, finalRef: null, repositoryIdentity: artifact.repositoryIdentity,
      worktreeIdentity: artifact.worktreeIdentity, paths: new Set(), additions: new Set() };
    if (scope.repositoryIdentity !== artifact.repositoryIdentity || scope.worktreeIdentity !== artifact.worktreeIdentity) {
      return outcome("refused", UNOWNED);
    }
    for (const file of artifact.files) {
      scope.paths.add(file.path);
      if (file.previousPath) scope.paths.add(file.previousPath);
      if (file.status === "added" || file.status === "renamed" || file.status === "copied") scope.additions.add(file.path);
    }
  }
  if (scope) scope.finalRef = finalRef;
  return scope;
}

function ownershipEstablished(store: RuntimeStore, conversationId: string): boolean {
  const conversation = store.conversation(conversationId);
  const ownership = store.conversationWorktrees.get(conversationId);
  if (ownership?.creationState === "creating") return false;
  return !ownership?.ownsWorktree
    || (conversation.worktreePath !== null && resolve(conversation.worktreePath) === resolve(ownership.path));
}

function sharedElsewhere(store: RuntimeStore, conversationId: string, scope: RecordedScope, repositoryPath: string): boolean {
  const activity = store.orchestration.history.workspaceActivity(conversationId, scope.worktreeIdentity,
    scope.target.turn.requestedAt);
  return activity.changed || activity.more || activity.unknown.some((otherId) => {
    try { return store.conversationWork.conversationMatchesCheckout(otherId, repositoryPath); }
    catch { return true; }
  });
}

async function withSnapshot<T>(repositoryPath: string, conversationId: string, storage: string, deadlineAt: number,
  inspect: (ref: string) => Promise<T>): Promise<T> {
  const current = await createCheckpoint(repositoryPath, storage, conversationId, { deadlineAt });
  try { return await inspect(current.ref); }
  finally { await deleteCheckpoint(repositoryPath, current.ref, conversationId).catch(() => undefined); }
}

async function changedFiles(repositoryPath: string, scope: RecordedScope, ref: string, deadlineAt: number) {
  const state = await captureGitArtifactState(repositoryPath, ref, { deadlineAt });
  if (state.repositoryIdentity !== scope.repositoryIdentity || state.worktreeIdentity !== scope.worktreeIdentity) return null;
  const comparison = await compareGitSnapshots(repositoryPath, scope.target.beforeRef, ref, { deadlineAt, maxBytes: 1_024 });
  return { truncated: comparison.summaryTruncated, files: comparison.files };
}

async function leftovers(repositoryPath: string, scope: RecordedScope, ref: string, deadlineAt: number) {
  const remaining = await compareGitSnapshots(repositoryPath, scope.target.beforeRef, ref, { deadlineAt, maxBytes: 1_024 });
  const kept = remaining.files.map(({ path }) => path);
  const created = remaining.files.filter(({ path, status }) => status === "added" && scope.additions.has(path)).map(({ path }) => path);
  if (!scope.finalRef || created.length === 0 || created.length > MAX_DIFF_FILES || remaining.summaryTruncated) {
    return { kept, removable: [] as string[] };
  }
  const edited = await compareGitSnapshots(repositoryPath, scope.finalRef, ref, { deadlineAt, maxBytes: 1_024, paths: created });
  if (edited.summaryTruncated) return { kept, removable: [] as string[] };
  const changed = new Set(edited.files.flatMap(({ path, previousPath }) => previousPath ? [path, previousPath] : [path]));
  return { kept, removable: created.filter((path) => !changed.has(path)) };
}

async function removeCreated(repositoryPath: string, paths: readonly string[], deadlineAt: number): Promise<string[]> {
  if (paths.length === 0) return [];
  const options = { deadlineAt };
  const [root, workspace] = await Promise.all([repositoryRoot(repositoryPath, options), canonicalDirectoryPath(repositoryPath, options)]);
  const removed: string[] = [];
  for (const path of paths) {
    try {
      const [entry] = await validatedEntryPaths(root, [path], options);
      const target = resolve(root, entry!);
      if (!isContained(root, target) || !isContained(workspace, target) || target === workspace) continue;
      if (!(await lstat(target)).isFile()) continue;
      await unlink(target);
      removed.push(path);
    } catch {
      continue;
    }
  }
  return removed;
}

async function settleRestored(repositoryPath: string, conversationId: string, storage: string, scope: RecordedScope,
  restoredCount: number, deadlineAt: number, recoveryId: string | null): Promise<RollbackFileRestoreResult> {
  const restored = `Restored ${plural(restoredCount, "file")} changed by the rolled-back turns. A recovery checkpoint was saved first.`;
  try {
    const { kept, removable } = await withSnapshot(repositoryPath, conversationId, storage, deadlineAt,
      (ref) => leftovers(repositoryPath, scope, ref, deadlineAt));
    const removed = new Set(await removeCreated(repositoryPath, removable, deadlineAt));
    const remaining = kept.filter((path) => !removed.has(path));
    const parts = [restored];
    if (removed.size) parts.push(`Removed ${plural(removed.size, "file")} they created.`);
    if (remaining.length) parts.push(`Kept ${plural(remaining.length, "file")} that changed afterwards or that they did not create: ${listed(remaining)}.`);
    return outcome("restored", parts.join(" "), recoveryId);
  } catch {
    return outcome("restored", `${restored} Inertia could not verify the result.`, recoveryId);
  }
}

export async function restoreRolledBackFiles(store: RuntimeStore, input: RollbackFileRestoreInput): Promise<RollbackFileRestoreResult> {
  const scope = recordedScope(store, input.rolledBackTurnIds);
  if (scope === null) return outcome("unchanged", "The rolled-back turns recorded no file changes.");
  if ("outcome" in scope) return scope;
  const release = claimCheckoutForRestore(store, input.conversationId, input.activity);
  if (!release) return outcome("refused", BUSY);
  try {
    return await restoreClaimed(store, input, scope);
  } finally {
    release();
  }
}

async function restoreClaimed(store: RuntimeStore, input: RollbackFileRestoreInput, scope: RecordedScope): Promise<RollbackFileRestoreResult> {
  if (!ownershipEstablished(store, input.conversationId)) return outcome("refused", UNOWNED);
  const repositoryPath = store.conversationPath(input.conversationId);
  if (sharedElsewhere(store, input.conversationId, scope, repositoryPath)) return outcome("refused", SHARED);
  const deadlineAt = Date.now() + 60_000;
  let storage: string | null = null;
  let recovery = null as CheckpointSummary | null;
  try {
    storage = await mkdtemp(join(tmpdir(), "inertia-rollback-restore-"));
    const before = await withSnapshot(repositoryPath, input.conversationId, storage, deadlineAt,
      (ref) => changedFiles(repositoryPath, scope, ref, deadlineAt));
    if (!before) return outcome("refused", UNOWNED);
    if (before.truncated) return outcome("refused", "Too many files changed since the rolled-back turns started, so files were left unchanged.");
    if (before.files.length === 0) return outcome("unchanged", "The workspace already matches the point you rolled back to.");
    const outside = [...new Set(before.files.flatMap(({ path, previousPath }) => previousPath ? [path, previousPath] : [path])
      .filter((path) => !scope.paths.has(path)))];
    if (outside.length) {
      return outcome("refused", `Files the rolled-back turns did not change were modified since (${listed(outside)}), so files were left unchanged.`);
    }
    input.beginRestore();
    const checkpoint: CheckpointSummary = { id: scope.target.turn.id, conversationId: input.conversationId,
      turnId: scope.target.turn.id, ref: scope.target.beforeRef, label: "Before rolled-back turn", turnIndex: 0,
      filesChanged: before.files.length, insertions: 0, deletions: 0, createdAt: scope.target.createdAt };
    await (input.restoreCheckpoint ?? restoreConversationCheckpoint)(store, checkpoint, (saved) => { recovery = saved; },
      { turnId: input.recoveryTurnId, label: "Before file restore" });
    return await settleRestored(repositoryPath, input.conversationId, storage, scope, before.files.length, deadlineAt,
      recovery?.id ?? null);
  } catch (error) {
    return failed(error, recovery);
  } finally {
    if (storage) await rm(storage, { recursive: true, force: true }).catch(() => undefined);
  }
}
