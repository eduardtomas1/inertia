import type { IncidentObservation } from "../node/application-incidents";
import { CONVERSATION_HISTORY_PAGE_SIZE } from "../shared/conversation-history";
import { isAgentTurnTerminalStatus } from "../shared/turn-lifecycle";
import {
  CheckpointError,
  deleteCheckpointRefs,
  isValidCheckpointRef,
  resolveCheckpointCommonGitDir,
  type DeleteCheckpointRefsOptions,
} from "./checkpoints";
import type { RuntimeStore } from "./database";
import { mayBeInsideGitRepository } from "./git/paths";
import { isGitProcessTreeTerminationFailure } from "./git/types";
import { normalizeIdentityPath } from "./project-identity";
import type {
  ArtifactRefClearUpdate,
  RetainedArtifactRefRecord,
  RetainedCheckpointRecord,
} from "./persistence/types";

export const RESTORE_BACKUP_CHECKPOINT_LABEL = "Before checkpoint restore";

export interface CheckpointRetentionPolicy {
  maxTurnCheckpointsPerConversation: number;
  maxPostTurnRefsWithPatchPerConversation: number;
  maxPostTurnRefsWithoutPatchPerConversation: number;
  maxRestoreBackupsPerConversation: number;
  maxArchivedCheckpointsPerConversation: number;
  maxRefsPerRepository: number;
  deleteBatchSize: number;
}

export const DEFAULT_CHECKPOINT_RETENTION_POLICY: CheckpointRetentionPolicy = {
  maxTurnCheckpointsPerConversation: CONVERSATION_HISTORY_PAGE_SIZE,
  maxPostTurnRefsWithPatchPerConversation: 10,
  maxPostTurnRefsWithoutPatchPerConversation: CONVERSATION_HISTORY_PAGE_SIZE,
  maxRestoreBackupsPerConversation: 5,
  maxArchivedCheckpointsPerConversation: 1,
  maxRefsPerRepository: 2_000,
  deleteBatchSize: 500,
};

export interface CheckpointPruneFailure {
  repositoryPath: string;
  projectId: string | null;
  error: unknown;
}

export interface PruneCheckpointRefsOptions {
  policy?: Partial<CheckpointRetentionPolicy>;
  now?: () => Date;
  deadlineAt?: number;
  signal?: AbortSignal;
  isConversationProtected?: (conversationId: string) => boolean;
  isTurnProtected?: (turnId: string) => boolean;
  reportIncident?: (observation: IncidentObservation) => unknown;
  onFailure?: (failure: CheckpointPruneFailure) => void;
  deleteRefs?: (
    repositoryPath: string,
    refs: readonly string[],
    options?: DeleteCheckpointRefsOptions,
  ) => Promise<number>;
}

export interface CheckpointPruneResult {
  deletedRefCount: number;
  expiredCheckpointCount: number;
  clearedArtifactRefCount: number;
  failedRepositoryCount: number;
}

type EvictionTier = 0 | 1 | 2 | 3 | 4 | 5;

interface CandidateRefAction {
  ref: string;
  checkpointIds: string[];
  artifactUpdates: ArtifactRefClearUpdate[];
  archived: boolean;
  sortTimestamp: number;
  sortTieBreaker: string;
  tier: EvictionTier;
}

interface RepositoryBucket {
  gitRoot: string;
  commonGitDir: string;
  projectId: string | null;
  checkpoints: RetainedCheckpointRecord[];
  artifacts: RetainedArtifactRefRecord[];
}

function isRestoreBackupCheckpoint(record: Pick<RetainedCheckpointRecord, "turnId" | "label">): boolean {
  return record.turnId === null && record.label === RESTORE_BACKUP_CHECKPOINT_LABEL;
}

function isStoredPatchState(patchState: RetainedArtifactRefRecord["patchState"]): boolean {
  return patchState === "available" || patchState === "truncated" || patchState === "expired";
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExpectedNonRepositoryError(error: unknown): boolean {
  return error instanceof CheckpointError && error.message === "not-repository";
}

function mergeArtifactUpdates(updates: readonly ArtifactRefClearUpdate[]): ArtifactRefClearUpdate[] {
  const merged = new Map<string, { clearBeforeRef: boolean; clearAfterRef: boolean }>();
  for (const update of updates) {
    const existing = merged.get(update.turnId) ?? { clearBeforeRef: false, clearAfterRef: false };
    if (update.clearBeforeRef) existing.clearBeforeRef = true;
    if (update.clearAfterRef) existing.clearAfterRef = true;
    merged.set(update.turnId, existing);
  }
  return [...merged.entries()].map(([turnId, flags]) => ({
    turnId,
    ...(flags.clearBeforeRef ? { clearBeforeRef: true } : {}),
    ...(flags.clearAfterRef ? { clearAfterRef: true } : {}),
  }));
}

function resolvePolicy(overrides?: Partial<CheckpointRetentionPolicy>): CheckpointRetentionPolicy {
  return {
    maxTurnCheckpointsPerConversation: Math.max(
      1,
      overrides?.maxTurnCheckpointsPerConversation
        ?? DEFAULT_CHECKPOINT_RETENTION_POLICY.maxTurnCheckpointsPerConversation,
    ),
    maxPostTurnRefsWithPatchPerConversation: Math.max(
      0,
      overrides?.maxPostTurnRefsWithPatchPerConversation
        ?? DEFAULT_CHECKPOINT_RETENTION_POLICY.maxPostTurnRefsWithPatchPerConversation,
    ),
    maxPostTurnRefsWithoutPatchPerConversation: Math.max(
      0,
      overrides?.maxPostTurnRefsWithoutPatchPerConversation
        ?? DEFAULT_CHECKPOINT_RETENTION_POLICY.maxPostTurnRefsWithoutPatchPerConversation,
    ),
    maxRestoreBackupsPerConversation: Math.max(
      0,
      overrides?.maxRestoreBackupsPerConversation
        ?? DEFAULT_CHECKPOINT_RETENTION_POLICY.maxRestoreBackupsPerConversation,
    ),
    maxArchivedCheckpointsPerConversation: Math.max(
      0,
      overrides?.maxArchivedCheckpointsPerConversation
        ?? DEFAULT_CHECKPOINT_RETENTION_POLICY.maxArchivedCheckpointsPerConversation,
    ),
    maxRefsPerRepository: Math.max(
      0,
      overrides?.maxRefsPerRepository
        ?? DEFAULT_CHECKPOINT_RETENTION_POLICY.maxRefsPerRepository,
    ),
    deleteBatchSize: Math.max(
      1,
      overrides?.deleteBatchSize
        ?? DEFAULT_CHECKPOINT_RETENTION_POLICY.deleteBatchSize,
    ),
  };
}

function recordPruneFailure(
  options: PruneCheckpointRefsOptions,
  failure: CheckpointPruneFailure,
): void {
  const detail = failure.error instanceof Error ? failure.error.message : String(failure.error);
  console.warn("Checkpoint ref pruning failed; will retry at next prune.", {
    projectId: failure.projectId,
    reason: detail.slice(0, 240),
  });
  options.reportIncident?.({
    code: "git.command-failed",
    outcome: "failed",
    context: {
      ...(failure.projectId ? { projectId: failure.projectId } : {}),
      commandType: "checkpoint.prune",
    },
  });
  options.onFailure?.(failure);
}

export async function pruneCheckpointRefs(
  store: Pick<
    RuntimeStore,
    | "activeCheckpointsForRetention"
    | "retainedTurnGitArtifactRefsForRetention"
    | "markCheckpointsExpired"
    | "clearTurnGitArtifactRefs"
    | "hasActiveWorkspaceRunForConversation"
  >,
  options: PruneCheckpointRefsOptions = {},
): Promise<CheckpointPruneResult> {
  const policy = resolvePolicy(options.policy);
  const now = options.now ?? (() => new Date());
  const deleteRefsFn = options.deleteRefs ?? deleteCheckpointRefs;
  const result: CheckpointPruneResult = {
    deletedRefCount: 0,
    expiredCheckpointCount: 0,
    clearedArtifactRefCount: 0,
    failedRepositoryCount: 0,
  };
  if (options.signal?.aborted) return result;

  const checkpoints = store.activeCheckpointsForRetention();
  const artifacts = store.retainedTurnGitArtifactRefsForRetention();
  if (checkpoints.length === 0 && artifacts.length === 0) return result;

  const fullyProtectedConversations = new Set<string>();
  const protectedTurns = new Set<string>();
  for (const record of checkpoints) {
    if (
      store.hasActiveWorkspaceRunForConversation(record.conversationId)
      || options.isConversationProtected?.(record.conversationId)
    ) {
      fullyProtectedConversations.add(record.conversationId);
    }
    if (record.turnId !== null) {
      if (
        (record.turnStatus !== null && !isAgentTurnTerminalStatus(record.turnStatus))
        || options.isTurnProtected?.(record.turnId)
      ) {
        protectedTurns.add(record.turnId);
      }
    }
  }
  for (const record of artifacts) {
    if (
      store.hasActiveWorkspaceRunForConversation(record.conversationId)
      || options.isConversationProtected?.(record.conversationId)
    ) {
      fullyProtectedConversations.add(record.conversationId);
    }
    if (
      record.status === "pending"
      || !isAgentTurnTerminalStatus(record.turnStatus)
      || options.isTurnProtected?.(record.turnId)
    ) {
      protectedTurns.add(record.turnId);
    }
  }

  const resolvedPathCache = new Map<string, { gitRoot: string; commonGitDir: string } | null>();
  const buckets = new Map<string, RepositoryBucket>();
  const failedPaths = new Set<string>();

  const resolveBucket = async (
    checkoutPath: string,
    projectId: string,
    workspaceKind: string | null,
  ): Promise<RepositoryBucket | null> => {
    if (workspaceKind === "scratch") return null;
    if (resolvedPathCache.has(checkoutPath)) {
      const cached = resolvedPathCache.get(checkoutPath);
      return cached ? (buckets.get(cached.commonGitDir) ?? null) : null;
    }
    if (!await mayBeInsideGitRepository(checkoutPath, {
      deadlineAt: options.deadlineAt,
      signal: options.signal,
    })) {
      resolvedPathCache.set(checkoutPath, null);
      return null;
    }
    try {
      const resolved = await resolveCheckpointCommonGitDir(checkoutPath, {
        deadlineAt: options.deadlineAt,
        signal: options.signal,
      });
      resolvedPathCache.set(checkoutPath, resolved);
      let bucket = buckets.get(resolved.commonGitDir);
      if (!bucket) {
        bucket = {
          gitRoot: resolved.gitRoot,
          commonGitDir: resolved.commonGitDir,
          projectId,
          checkpoints: [],
          artifacts: [],
        };
        buckets.set(resolved.commonGitDir, bucket);
      }
      return bucket;
    } catch (error) {
      if (isGitProcessTreeTerminationFailure(error)) throw error;
      resolvedPathCache.set(checkoutPath, null);
      if (!isExpectedNonRepositoryError(error) && !failedPaths.has(checkoutPath)) {
        failedPaths.add(checkoutPath);
        result.failedRepositoryCount += 1;
        recordPruneFailure(options, {
          repositoryPath: checkoutPath,
          projectId,
          error,
        });
      }
      return null;
    }
  };

  const resolveFallbackBucket = async (
    projectPath: string,
    projectId: string,
    workspaceKind: string | null,
    expectedRepositoryIdentity: string | null,
  ): Promise<RepositoryBucket | null> => {
    if (!expectedRepositoryIdentity) return null;
    const candidate = await resolveBucket(projectPath, projectId, workspaceKind);
    if (!candidate) return null;
    if (`git:${normalizeIdentityPath(candidate.commonGitDir)}` !== expectedRepositoryIdentity) {
      return null;
    }
    return candidate;
  };

  for (const record of checkpoints) {
    if (options.signal?.aborted) return result;
    const bucket = record.worktreePath
      ? (await resolveBucket(record.worktreePath, record.projectId, record.projectWorkspaceKind))
        ?? (await resolveFallbackBucket(record.projectPath, record.projectId, record.projectWorkspaceKind, record.projectRepositoryIdentity))
      : await resolveBucket(record.projectPath, record.projectId, record.projectWorkspaceKind);
    if (bucket) bucket.checkpoints.push(record);
  }
  for (const record of artifacts) {
    if (options.signal?.aborted) return result;
    const bucket = record.worktreePath
      ? (await resolveBucket(record.worktreePath, record.projectId, record.projectWorkspaceKind))
        ?? (await resolveFallbackBucket(record.projectPath, record.projectId, record.projectWorkspaceKind, record.projectRepositoryIdentity))
      : await resolveBucket(record.projectPath, record.projectId, record.projectWorkspaceKind);
    if (bucket) bucket.artifacts.push(record);
  }

  for (const bucket of buckets.values()) {
    if (options.signal?.aborted) break;
    await pruneRepositoryBucket(
      store,
      bucket,
      policy,
      fullyProtectedConversations,
      protectedTurns,
      now,
      options,
      deleteRefsFn,
      result,
    );
  }

  return result;
}

async function pruneRepositoryBucket(
  store: Pick<RuntimeStore, "markCheckpointsExpired" | "clearTurnGitArtifactRefs" | "hasActiveWorkspaceRunForConversation">,
  bucket: RepositoryBucket,
  policy: CheckpointRetentionPolicy,
  fullyProtectedConversations: ReadonlySet<string>,
  protectedTurns: ReadonlySet<string>,
  now: () => Date,
  options: PruneCheckpointRefsOptions,
  deleteRefsFn: NonNullable<PruneCheckpointRefsOptions["deleteRefs"]>,
  result: CheckpointPruneResult,
): Promise<void> {
  const checkpointById = new Map<string, RetainedCheckpointRecord>();
  for (const cp of bucket.checkpoints) checkpointById.set(cp.id, cp);

  const expiredCheckpointIds = new Set<string>();
  const clearBeforeTurns = new Set<string>();
  const clearAfterTurns = new Set<string>();
  const protectedCheckpointIds = new Set<string>();
  const protectedAfterTurns = new Set<string>();
  const protectedBeforeTurns = new Set<string>();

  const checkpointsByConversation = new Map<string, RetainedCheckpointRecord[]>();
  for (const cp of bucket.checkpoints) {
    const list = checkpointsByConversation.get(cp.conversationId) ?? [];
    list.push(cp);
    checkpointsByConversation.set(cp.conversationId, list);
  }

  for (const [conversationId, conversationCheckpoints] of checkpointsByConversation) {
    const conversationProtected = fullyProtectedConversations.has(conversationId);
    const archived = conversationCheckpoints[0]?.archivedAt !== null;
    if (conversationProtected) {
      for (const cp of conversationCheckpoints) protectedCheckpointIds.add(cp.id);
      continue;
    }
    if (archived) {
      let keptArchived = 0;
      for (const cp of conversationCheckpoints) {
        if (cp.turnId !== null && protectedTurns.has(cp.turnId)) {
          protectedCheckpointIds.add(cp.id);
          continue;
        }
        if (keptArchived < policy.maxArchivedCheckpointsPerConversation) {
          keptArchived += 1;
        } else {
          expiredCheckpointIds.add(cp.id);
        }
      }
      continue;
    }

    let keptTurnCheckpoints = 0;
    let keptRestoreBackups = 0;
    for (const cp of conversationCheckpoints) {
      if (cp.turnId !== null && protectedTurns.has(cp.turnId)) {
        protectedCheckpointIds.add(cp.id);
        continue;
      }
      if (isRestoreBackupCheckpoint(cp)) {
        if (keptRestoreBackups < policy.maxRestoreBackupsPerConversation) {
          keptRestoreBackups += 1;
        } else {
          expiredCheckpointIds.add(cp.id);
        }
      } else {
        if (keptTurnCheckpoints < policy.maxTurnCheckpointsPerConversation) {
          keptTurnCheckpoints += 1;
        } else {
          expiredCheckpointIds.add(cp.id);
        }
      }
    }
  }

  const artifactsByConversation = new Map<string, RetainedArtifactRefRecord[]>();
  for (const artifact of bucket.artifacts) {
    const list = artifactsByConversation.get(artifact.conversationId) ?? [];
    list.push(artifact);
    artifactsByConversation.set(artifact.conversationId, list);
  }

  for (const [conversationId, conversationArtifacts] of artifactsByConversation) {
    const conversationProtected = fullyProtectedConversations.has(conversationId);
    let keptPostWithPatch = 0;
    let keptPostWithoutPatch = 0;
    for (const artifact of conversationArtifacts) {
      const turnProtected = conversationProtected
        || protectedTurns.has(artifact.turnId)
        || artifact.status === "pending";
      const archived = artifact.archivedAt !== null;

      if (artifact.beforeRef !== null) {
        if (turnProtected) {
          protectedBeforeTurns.add(artifact.turnId);
        } else if (artifact.beforeCheckpointId === null) {
          clearBeforeTurns.add(artifact.turnId);
        } else if (expiredCheckpointIds.has(artifact.beforeCheckpointId)) {
          clearBeforeTurns.add(artifact.turnId);
        }
      }

      if (artifact.afterRef !== null) {
        if (turnProtected) {
          protectedAfterTurns.add(artifact.turnId);
        } else if (archived) {
          clearAfterTurns.add(artifact.turnId);
        } else if (isStoredPatchState(artifact.patchState)) {
          if (keptPostWithPatch < policy.maxPostTurnRefsWithPatchPerConversation) {
            keptPostWithPatch += 1;
          } else {
            clearAfterTurns.add(artifact.turnId);
          }
        } else if (keptPostWithoutPatch < policy.maxPostTurnRefsWithoutPatchPerConversation) {
          keptPostWithoutPatch += 1;
        } else {
          clearAfterTurns.add(artifact.turnId);
        }
      }
    }
  }

  const protectedRefs = new Set<string>();
  const retainedNonProtectedRefs = new Map<string, CandidateRefAction>();

  const registerRetained = (
    ref: string,
    tier: EvictionTier,
    archived: boolean,
    sortTimestamp: number,
    sortTieBreaker: string,
    checkpointId: string | null,
    artifactUpdate: ArtifactRefClearUpdate | null,
  ): void => {
    if (!isValidCheckpointRef(ref) || protectedRefs.has(ref)) return;
    const existing = retainedNonProtectedRefs.get(ref);
    if (!existing) {
      retainedNonProtectedRefs.set(ref, {
        ref,
        checkpointIds: checkpointId ? [checkpointId] : [],
        artifactUpdates: artifactUpdate ? [artifactUpdate] : [],
        archived,
        sortTimestamp,
        sortTieBreaker,
        tier,
      });
      return;
    }
    if (checkpointId && !existing.checkpointIds.includes(checkpointId)) {
      existing.checkpointIds.push(checkpointId);
    }
    if (artifactUpdate) existing.artifactUpdates.push(artifactUpdate);
    if (tier > existing.tier) existing.tier = tier;
    if (!archived) existing.archived = false;
    if (sortTimestamp > existing.sortTimestamp) existing.sortTimestamp = sortTimestamp;
  };

  for (const cp of bucket.checkpoints) {
    if (protectedCheckpointIds.has(cp.id) && isValidCheckpointRef(cp.ref)) {
      protectedRefs.add(cp.ref);
    }
  }
  for (const artifact of bucket.artifacts) {
    if (artifact.beforeRef && protectedBeforeTurns.has(artifact.turnId) && isValidCheckpointRef(artifact.beforeRef)) {
      protectedRefs.add(artifact.beforeRef);
    }
    if (artifact.afterRef && protectedAfterTurns.has(artifact.turnId) && isValidCheckpointRef(artifact.afterRef)) {
      protectedRefs.add(artifact.afterRef);
    }
  }

  for (const cp of bucket.checkpoints) {
    if (expiredCheckpointIds.has(cp.id) || protectedCheckpointIds.has(cp.id)) continue;
    const archived = cp.archivedAt !== null;
    const tier: EvictionTier = isRestoreBackupCheckpoint(cp)
      ? (archived ? 2 : 3)
      : (archived ? 4 : 5);
    registerRetained(
      cp.ref,
      tier,
      archived,
      parseTimestamp(cp.createdAt),
      cp.id,
      cp.id,
      null,
    );
  }

  for (const artifact of bucket.artifacts) {
    const archived = artifact.archivedAt !== null;
    const ts = parseTimestamp(artifact.createdAt);
    if (
      artifact.beforeRef !== null
      && !protectedBeforeTurns.has(artifact.turnId)
      && !clearBeforeTurns.has(artifact.turnId)
    ) {
      const linkedCp = artifact.beforeCheckpointId ? checkpointById.get(artifact.beforeCheckpointId) : null;
      const tier: EvictionTier = linkedCp
        ? (isRestoreBackupCheckpoint(linkedCp) ? (archived ? 2 : 3) : (archived ? 4 : 5))
        : (archived ? 0 : 1);
      registerRetained(
        artifact.beforeRef,
        tier,
        archived,
        ts,
        `${artifact.turnId}:before`,
        null,
        { turnId: artifact.turnId, clearBeforeRef: true },
      );
    }
    if (
      artifact.afterRef !== null
      && !protectedAfterTurns.has(artifact.turnId)
      && !clearAfterTurns.has(artifact.turnId)
    ) {
      registerRetained(
        artifact.afterRef,
        archived ? 0 : 1,
        archived,
        ts,
        `${artifact.turnId}:after`,
        null,
        { turnId: artifact.turnId, clearAfterRef: true },
      );
    }
  }

  if (retainedNonProtectedRefs.size > policy.maxRefsPerRepository) {
    const overflowCount = retainedNonProtectedRefs.size - policy.maxRefsPerRepository;
    const orderedForEviction = [...retainedNonProtectedRefs.values()].sort((left, right) => (
      left.tier - right.tier
      || left.sortTimestamp - right.sortTimestamp
      || left.sortTieBreaker.localeCompare(right.sortTieBreaker, "en")
    ));
    for (const candidate of orderedForEviction.slice(0, overflowCount)) {
      for (const cpId of candidate.checkpointIds) expiredCheckpointIds.add(cpId);
      for (const update of candidate.artifactUpdates) {
        if (update.clearBeforeRef) clearBeforeTurns.add(update.turnId);
        if (update.clearAfterRef) clearAfterTurns.add(update.turnId);
      }
      retainedNonProtectedRefs.delete(candidate.ref);
    }
  }

  const stillReferencedRefs = new Set<string>(protectedRefs);
  for (const ref of retainedNonProtectedRefs.keys()) stillReferencedRefs.add(ref);
  for (const cp of bucket.checkpoints) {
    if (!expiredCheckpointIds.has(cp.id) && isValidCheckpointRef(cp.ref)) {
      stillReferencedRefs.add(cp.ref);
    }
  }
  for (const artifact of bucket.artifacts) {
    if (artifact.beforeRef && !clearBeforeTurns.has(artifact.turnId) && isValidCheckpointRef(artifact.beforeRef)) {
      stillReferencedRefs.add(artifact.beforeRef);
    }
    if (artifact.afterRef && !clearAfterTurns.has(artifact.turnId) && isValidCheckpointRef(artifact.afterRef)) {
      stillReferencedRefs.add(artifact.afterRef);
    }
  }

  const refActions = new Map<string, {
    checkpointIds: string[];
    artifactUpdates: ArtifactRefClearUpdate[];
    conversationIds: Set<string>;
    turnIds: Set<string>;
  }>();
  const addRefAction = (
    ref: string,
    checkpointId: string | null,
    artifactUpdate: ArtifactRefClearUpdate | null,
    conversationId: string,
    turnId: string | null,
  ): void => {
    const entry = refActions.get(ref) ?? {
      checkpointIds: [],
      artifactUpdates: [],
      conversationIds: new Set<string>(),
      turnIds: new Set<string>(),
    };
    if (checkpointId && !entry.checkpointIds.includes(checkpointId)) {
      entry.checkpointIds.push(checkpointId);
    }
    if (artifactUpdate) entry.artifactUpdates.push(artifactUpdate);
    entry.conversationIds.add(conversationId);
    if (turnId) entry.turnIds.add(turnId);
    refActions.set(ref, entry);
  };

  const invalidRefCheckpointIds: string[] = [];
  const invalidRefArtifactUpdates: ArtifactRefClearUpdate[] = [];
  const sharedStillRetainedCheckpointIds: string[] = [];
  const sharedStillRetainedArtifactUpdates: ArtifactRefClearUpdate[] = [];

  for (const cpId of expiredCheckpointIds) {
    const cp = checkpointById.get(cpId);
    if (!cp) continue;
    if (!isValidCheckpointRef(cp.ref)) {
      invalidRefCheckpointIds.push(cp.id);
    } else if (stillReferencedRefs.has(cp.ref)) {
      sharedStillRetainedCheckpointIds.push(cp.id);
    } else {
      addRefAction(cp.ref, cp.id, null, cp.conversationId, cp.turnId);
    }
  }

  for (const artifact of bucket.artifacts) {
    if (artifact.beforeRef && clearBeforeTurns.has(artifact.turnId)) {
      const update: ArtifactRefClearUpdate = { turnId: artifact.turnId, clearBeforeRef: true };
      if (!isValidCheckpointRef(artifact.beforeRef)) {
        invalidRefArtifactUpdates.push(update);
      } else if (stillReferencedRefs.has(artifact.beforeRef)) {
        sharedStillRetainedArtifactUpdates.push(update);
      } else {
        addRefAction(artifact.beforeRef, null, update, artifact.conversationId, artifact.turnId);
      }
    }
    if (artifact.afterRef && clearAfterTurns.has(artifact.turnId)) {
      const update: ArtifactRefClearUpdate = { turnId: artifact.turnId, clearAfterRef: true };
      if (!isValidCheckpointRef(artifact.afterRef)) {
        invalidRefArtifactUpdates.push(update);
      } else if (stillReferencedRefs.has(artifact.afterRef)) {
        sharedStillRetainedArtifactUpdates.push(update);
      } else {
        addRefAction(artifact.afterRef, null, update, artifact.conversationId, artifact.turnId);
      }
    }
  }

  const timestamp = now().toISOString();
  const immediateCheckpointIds = [...invalidRefCheckpointIds, ...sharedStillRetainedCheckpointIds];
  if (immediateCheckpointIds.length > 0) {
    result.expiredCheckpointCount += store.markCheckpointsExpired(immediateCheckpointIds, timestamp);
  }
  const immediateArtifactUpdates = mergeArtifactUpdates([
    ...invalidRefArtifactUpdates,
    ...sharedStillRetainedArtifactUpdates,
  ]);
  if (immediateArtifactUpdates.length > 0) {
    result.clearedArtifactRefCount += store.clearTurnGitArtifactRefs(immediateArtifactUpdates, timestamp);
  }

  const refsToDelete = [...refActions.keys()];
  if (refsToDelete.length === 0) return;

  const isRefProtectedLive = (ref: string): boolean => {
    const action = refActions.get(ref);
    if (!action) return true;
    for (const conversationId of action.conversationIds) {
      if (options.isConversationProtected?.(conversationId) || store.hasActiveWorkspaceRunForConversation(conversationId)) {
        return true;
      }
    }
    for (const turnId of action.turnIds) {
      if (options.isTurnProtected?.(turnId)) return true;
    }
    return false;
  };

  for (let offset = 0; offset < refsToDelete.length; offset += policy.deleteBatchSize) {
    if (options.signal?.aborted) break;
    const batchRefs = refsToDelete
      .slice(offset, offset + policy.deleteBatchSize)
      .filter((ref) => !isRefProtectedLive(ref));
    if (batchRefs.length === 0) continue;
    try {
      const deleted = await deleteRefsFn(bucket.gitRoot, batchRefs, {
        batchSize: policy.deleteBatchSize,
        deadlineAt: options.deadlineAt,
        signal: options.signal,
      });
      result.deletedRefCount += deleted;
      const batchCheckpointIds: string[] = [];
      const batchArtifactUpdates: ArtifactRefClearUpdate[] = [];
      for (const ref of batchRefs) {
        const action = refActions.get(ref);
        if (!action) continue;
        batchCheckpointIds.push(...action.checkpointIds);
        batchArtifactUpdates.push(...action.artifactUpdates);
      }
      const batchTimestamp = now().toISOString();
      if (batchCheckpointIds.length > 0) {
        result.expiredCheckpointCount += store.markCheckpointsExpired(batchCheckpointIds, batchTimestamp);
      }
      const mergedUpdates = mergeArtifactUpdates(batchArtifactUpdates);
      if (mergedUpdates.length > 0) {
        result.clearedArtifactRefCount += store.clearTurnGitArtifactRefs(mergedUpdates, batchTimestamp);
      }
    } catch (error) {
      if (isGitProcessTreeTerminationFailure(error)) throw error;
      if (!isExpectedNonRepositoryError(error)) {
        result.failedRepositoryCount += 1;
        recordPruneFailure(options, {
          repositoryPath: bucket.gitRoot,
          projectId: bucket.projectId,
          error,
        });
      }
      break;
    }
  }
}
