import { randomUUID } from "node:crypto";

import { modelSelectionSchema, versionedContinuationIdentitySchema } from "../../shared/model-routing";
import type { ConversationRollbackResult, HistoryRollbackPlan, RollbackFiles } from "../../shared/orchestration-history";
import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";
import type { ProviderTerminalResumeRegistry } from "../provider/terminal-resume";
import type { TerminalManager } from "../terminal";
import type { NativeConversationBoundary } from "../provider/native-conversation-operations";
import type { TurnController } from "./turns/turn-controller";
import { HistoryRollbackError } from "../orchestration-v2/history-rollback-repository";
import type { CommandSource } from "../orchestration-v2/types";
import { commandFingerprint, durableJson } from "../orchestration-v2/json";
import { providerInstanceId } from "../orchestration-v2/provider-instance";
import { ensureOrchestrationThread } from "../orchestration-v2/thread-registration";
import { RuntimeRequestError } from "../runtime-errors";
import { restoreRolledBackFiles, type RestoreConversationCheckpoint, type RollbackFileRestoreResult } from "./rollback-file-restore";

export interface HistoryRollbackDependencies {
  store: RuntimeStore;
  providers: Pick<ProviderManager, "resolveModelRoute" | "nativeConversation" | "isRunning">;
  turns: Pick<TurnController, "acquireTurnAdmission" | "forgetPromptDelivery" | "checkoutActivityConversationIds">;
  providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "acquire" | "release">;
  terminals?: Pick<TerminalManager, "liveSessionScopes">;
  restoreCheckpoint?: RestoreConversationCheckpoint;
}

const DUO_ACTIVE = "This chat belongs to a Duo that is still running or needs attention. Let its chats finish or stop them, or resolve it from the Duo dialog (the two-chats button in the sidebar), then roll back again.";

function assertDuoSettled(store: RuntimeStore, conversationId: string): void {
  let active = false;
  try { store.assertConversationDeletionAllowed(conversationId); } catch { active = true; }
  const related = store.pairedLaunchIdsForDeletionRecovery({ conversationId }, 1);
  if (active || related.launchIds.length > 0 || related.hasMore) throw new RuntimeRequestError(DUO_ACTIVE);
}

export async function rollbackConversationHistory(dependencies: HistoryRollbackDependencies,
  input: { conversationId: string; turnId: string | null; restoreFiles?: boolean; source: CommandSource },
  signal: AbortSignal): Promise<ConversationRollbackResult> {
  const { store, providers, turns, providerTerminalResumes } = dependencies;
  const conversationId = input.conversationId;
  const conversation = store.conversation(conversationId);
  const restoreFiles = input.restoreFiles === true;
  const command = { threadId: conversationId, projectId: conversation.projectId, source: input.source, restoreFiles };
  const replay = (): ConversationRollbackResult | null => {
    try { return store.orchestration.history.replay(command); }
    catch (error) { if (error instanceof HistoryRollbackError) throw new RuntimeRequestError(error.message); throw error; }
  };
  const settleFiles = async (result: ConversationRollbackResult, plan: HistoryRollbackPlan): Promise<ConversationRollbackResult> => {
    const rollbackId = result.rollbackId;
    if (!restoreFiles || rollbackId === null || result.transfer === "unchanged") return result;
    const record = (state: RollbackFiles["outcome"] | "restoring", message: string | null, recoveryCheckpointId: string | null = null) =>
      store.orchestration.history.recordFiles(conversationId, conversation.projectId, rollbackId, state, message, recoveryCheckpointId);
    let files: RollbackFileRestoreResult;
    try {
      files = await restoreRolledBackFiles(store, { conversationId, rolledBackTurnIds: plan.rolledBackTurnIds,
        recoveryTurnId: plan.retainedTurnId ?? plan.rolledBackTurnIds[0]!, beginRestore: () => record("restoring", null),
        activity: { turns, ...(dependencies.terminals ? { terminals: dependencies.terminals } : {}) },
        ...(dependencies.restoreCheckpoint ? { restoreCheckpoint: dependencies.restoreCheckpoint } : {}) });
    } catch {
      files = { outcome: "failed", message: "Inertia could not restore the files. Review the workspace.", recoveryCheckpointId: null };
    }
    record(files.outcome, files.message ?? "Files were left unchanged.", files.recoveryCheckpointId);
    return replay()!;
  };
  const recorded = replay();
  if (recorded) return recorded;
  assertDuoSettled(store, conversationId);
  if (store.orchestration.forks.get(conversationId)?.transfer === "pending") {
    throw new RuntimeRequestError("This fork has no turns of its own to roll back.");
  }
  const busy = () => store.orchestration.awaitsCleanupProof(conversationId) || providers.isRunning(conversationId);
  if (busy() || store.hasActiveWorkspaceRunForConversation(conversationId)) throw new RuntimeRequestError("Stop active work and wait for cleanup before rolling back this chat.");
  const admission = await turns.acquireTurnAdmission(conversationId, 1_000);
  if (!admission) throw new RuntimeRequestError("This chat is busy. Try rolling back again in a moment.");
  let reserved = false;
  try {
    signal.throwIfAborted();
    reserved = providerTerminalResumes.acquire(conversationId);
    if (!reserved || busy()) throw new RuntimeRequestError("Stop active work, reviews, or resumed terminals before rolling back.");
    assertDuoSettled(store, conversationId);
    const replayed = replay();
    if (replayed) return replayed;
    let plan;
    try { plan = store.orchestration.history.plan(conversationId, input.turnId); }
    catch (error) { if (error instanceof HistoryRollbackError) throw new RuntimeRequestError(error.message); throw error; }
    if (!plan) return store.orchestration.history.recordUnchanged(command, input.turnId);
    const operationId = randomUUID();
    const selection = modelSelectionSchema.parse(conversation.modelSelection);
    const route = providers.resolveModelRoute(selection);
    const instanceId = providerInstanceId(route.providerId, route.continuationIdentity);
    const workspaceKey = store.conversationPath(conversationId);
    const native = nativeTarget(store, conversationId, input.turnId, route, instanceId, workspaceKey);
    if ("reason" in native) {
      ensureOrchestrationThread(store.orchestration.events, conversation, workspaceKey);
      const result = store.orchestration.history.applyPortable(command, operationId, plan, native.reason);
      turns.forgetPromptDelivery(conversationId);
      return await settleFiles(result, plan);
    }
    const request = { kind: "rollback" as const, operationId, boundary: native.boundary,
      source: { identity: { projectId: conversation.projectId, conversationId, workspaceId: commandFingerprint({
        projectId: conversation.projectId, workspaceKey }), repositoryId: store.project(conversation.projectId).repositoryIdentity,
      providerInstanceId: instanceId }, nativeConversationId: native.nativeConversationId,
      ...(native.nativeSessionId ? { nativeSessionId: native.nativeSessionId } : {}), expectedHeadId: native.expectedHeadId } };
    const effect = store.orchestration.nativeControls.start({ id: operationId, threadId: conversationId,
      projectId: conversation.projectId, request, rollback: plan, sourceWorkspaceKey: workspaceKey, targetWorkspaceKey: workspaceKey,
      selection, continuationIdentity: versionedContinuationIdentitySchema.parse(route.continuationIdentity) },
    input.source, store.orchestration.history.nativeReceipt(operationId, plan, restoreFiles));
    try {
      const result = await providers.nativeConversation(request, selection, { cwd: workspaceKey, signal, timeoutMs: 30_000 });
      const after = store.conversation(conversationId);
      const afterRoute = providers.resolveModelRoute(after.modelSelection);
      if (durableJson(modelSelectionSchema.parse(after.modelSelection)) !== durableJson(selection)
        || providerInstanceId(afterRoute.providerId, afterRoute.continuationIdentity) !== instanceId
        || store.conversationPath(conversationId) !== workspaceKey) throw new Error("Native rollback scope changed.");
      const settled = store.orchestration.nativeControls.settle(effect, result);
      if (settled.state === "uncertain") throw new RuntimeRequestError("Native rollback cleanup is still pending.");
      turns.forgetPromptDelivery(conversationId);
      return await settleFiles(replay()!, plan);
    } catch (error) {
      if (store.orchestration.nativeControls.get(operationId)?.state === "running") store.orchestration.nativeControls.uncertain(effect);
      throw error;
    }
  } finally {
    if (reserved) providerTerminalResumes.release(conversationId);
    admission.release();
  }
}

function nativeTarget(store: RuntimeStore, threadId: string, turnId: string | null,
  route: ReturnType<HistoryRollbackDependencies["providers"]["resolveModelRoute"]>, instanceId: string, workspaceKey: string):
  { reason: string } | { boundary: NativeConversationBoundary; nativeConversationId: string; nativeSessionId: string | null;
    expectedHeadId: string } {
  const backing = store.orchestration.backings.find({ threadId, providerId: route.providerId, workspaceKey,
    identity: route.continuationIdentity });
  if (!backing || backing.status !== "ready" || store.conversation(threadId).providerSessionId !== backing.nativeSessionId) {
    return { reason: "native-backing-unavailable" };
  }
  let boundary: NativeConversationBoundary;
  let nativeSessionId: string | null = null;
  if (turnId === null) {
    const fork = store.orchestration.nativeControls.forkBacking(threadId);
    if (fork?.state !== "completed" || fork.backing?.nativeConversationId !== backing.nativeSessionId
      || fork.request.source.identity.providerInstanceId !== instanceId || fork.targetWorkspaceKey !== workspaceKey
      || fork.backing.headId === null) return { reason: "native-start-unavailable" };
    boundary = { kind: "start", inheritedHeadId: fork.backing.headId };
    nativeSessionId = fork.backing.nativeSessionId ?? null;
  } else {
    const run = store.orchestration.nativeBoundaries.forRun(store.agentTurn(turnId).runId);
    if (run?.phase !== "settled" || run.nativeTurnId === null || run.providerInstanceId !== instanceId
      || run.workspaceKey !== workspaceKey || run.nativeConversationId !== backing.nativeSessionId) {
      return { reason: "native-boundary-unavailable" };
    }
    boundary = { kind: "turn", nativeTurnId: run.nativeTurnId };
    nativeSessionId = run.nativeSessionId;
  }
  const expectedHeadId = store.orchestration.history.physicalHead({ threadId, providerInstanceId: instanceId,
    workspaceKey, nativeConversationId: backing.nativeSessionId });
  return expectedHeadId === null ? { reason: "native-head-unavailable" }
    : { boundary, nativeConversationId: backing.nativeSessionId, nativeSessionId, expectedHeadId };
}
