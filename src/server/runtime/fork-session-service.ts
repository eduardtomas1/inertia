import { randomUUID } from "node:crypto";

import { modelSelectionSchema, versionedContinuationIdentitySchema } from "../../shared/model-routing";
import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";
import type { ProviderTerminalResumeRegistry } from "../provider/terminal-resume";
import type { TurnController } from "./turns/turn-controller";
import { commandFingerprint, durableJson } from "../orchestration-v2/json";
import { providerInstanceId } from "../orchestration-v2/provider-instance";
import { RuntimeRequestError } from "../runtime-errors";
import { RecordNotFoundError } from "../persistence/errors";
import { harnessDeclaresCapability } from "../provider/capability-manifest";
import { nativeControlLockResources } from "../orchestration-v2/native-control-projector";
import { OrchestrationConflict } from "../orchestration-v2/types";

interface ForkSessionDependencies {
  store: RuntimeStore;
  providers: Pick<ProviderManager, "resolveModelRoute" | "nativeConversation" | "isRunning">;
  turns: Pick<TurnController, "acquireTurnAdmission">;
  providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "acquire" | "release">;
}

/** First-send resolution. The target admission lease is already held by the caller. */
export async function prepareForkSession(dependencies: ForkSessionDependencies, conversationId: string,
  signal: AbortSignal): Promise<void> {
  await dependencies.store.orchestration.lanes.run(conversationId,
    () => prepareOrderedForkSession(dependencies, conversationId, signal));
}

async function prepareOrderedForkSession(dependencies: ForkSessionDependencies, conversationId: string,
  signal: AbortSignal): Promise<void> {
  const { store, providers, turns, providerTerminalResumes } = dependencies;
  const fork = store.orchestration.forks.get(conversationId);
  if (!fork || fork.transfer !== "pending") return;
  if (store.orchestration.nativeControls.locked(conversationId)) {
    throw new RuntimeRequestError("Native fork cleanup must be confirmed before this chat can continue.");
  }
  if (store.hasConversationTurns(conversationId)) return;
  const portable = (reason: string) => store.orchestration.nativeControls.selectPortable(conversationId, fork.projectId, reason);
  const target = store.conversation(conversationId);
  const route = providers.resolveModelRoute(target.modelSelection);
  const boundary = fork.nativeBoundary;
  if (!boundary?.nativeTurnId || boundary.phase !== "settled"
    || providerInstanceId(route.providerId, route.continuationIdentity) !== boundary.providerInstanceId) {
    portable("native-boundary-unavailable");
    return;
  }
  let source, sourceTurn;
  try { source = store.conversation(fork.parentThreadId); sourceTurn = store.agentTurn(fork.sourceTurnId); }
  catch (error) { if (!(error instanceof RecordNotFoundError)) throw error; portable("source-removed"); return; }
  if (sourceTurn.status !== "completed") {
    portable("native-source-unsuccessful");
    return;
  }
  // T3 `canForkWhileSourceRunning` (`CommandPolicy.ts:398`, `ProviderTurnStartService.ts:1240`): a harness that
  // reads a running source safely forks natively from the completed boundary turn while a later source turn runs.
  const forksLive = harnessDeclaresCapability(route.harnessId, "fork-while-source-running");
  const sourceBusy = providers.isRunning(source.id) || store.orchestration.awaitsCleanupProof(source.id);
  if (source.projectId !== target.projectId || source.providerId !== route.providerId
    || store.conversationPath(source.id) !== fork.sourceWorkspaceKey
    || store.orchestration.nativeControls.locked(source.id) || sourceBusy && !forksLive) {
    portable("native-source-unavailable");
    return;
  }
  signal.throwIfAborted();
  // A source busy with a provider run is read live and not held. An idle one is held still for the whole operation,
  // and one held by other work (a rollback, a terminal resume) stays portable.
  const live = sourceBusy;
  const admission = live ? null : await turns.acquireTurnAdmission(source.id, 100);
  if (!live && !admission) { portable("native-source-busy"); return; }
  let sourceReserved = false;
  try {
    signal.throwIfAborted();
    if (!live) {
      sourceReserved = providerTerminalResumes.acquire(source.id);
      if (!sourceReserved) { portable("native-source-busy"); return; }
    }
    const current = store.conversation(conversationId);
    const selection = modelSelectionSchema.parse(current.modelSelection);
    const currentRoute = providers.resolveModelRoute(selection);
    if (current.projectId !== fork.projectId
      || providerInstanceId(currentRoute.providerId, currentRoute.continuationIdentity) !== boundary.providerInstanceId
      || store.conversationPath(source.id) !== fork.sourceWorkspaceKey) {
      portable("native-route-changed"); return;
    }
    // A live source's newest boundary is its running turn's; the fork checks against the last settled head.
    const expectedHeadId = store.orchestration.history.physicalHead({ threadId: source.id,
      providerInstanceId: boundary.providerInstanceId, nativeConversationId: boundary.nativeConversationId }, { settledOnly: live });
    if (expectedHeadId === null) { portable("native-head-unavailable"); return; }
    const workspaceKey = store.conversationPath(conversationId);
    const operationId = randomUUID();
    const request = { kind: "fork" as const, operationId, targetConversationId: conversationId,
      source: { identity: { projectId: fork.projectId, conversationId: source.id,
        workspaceId: commandFingerprint({ projectId: fork.projectId, workspaceKey: fork.sourceWorkspaceKey }),
        repositoryId: store.project(fork.projectId).repositoryIdentity,
        providerInstanceId: boundary.providerInstanceId }, nativeConversationId: boundary.nativeConversationId,
        ...(boundary.nativeSessionId === null ? {} : { nativeSessionId: boundary.nativeSessionId }), expectedHeadId,
        ...(live ? { live: true as const } : {}) },
      boundary: { kind: "turn" as const, nativeTurnId: boundary.nativeTurnId } };
    const control = { id: operationId, threadId: conversationId,
      projectId: fork.projectId, request, sourceWorkspaceKey: fork.sourceWorkspaceKey,
      targetWorkspaceKey: workspaceKey, selection,
      continuationIdentity: versionedContinuationIdentitySchema.parse(currentRoute.continuationIdentity) };
    // Another native control of the same provider conversation (a live fork of it still reading after the source
    // went idle, or one a crash left unconfirmed) leaves this fork portable instead of failing its send.
    if (nativeControlLockResources(control).some((id) => store.orchestration.nativeControls.locked(id))) {
      portable("native-source-busy"); return;
    }
    let effect;
    try {
      effect = store.orchestration.nativeControls.start(control);
    } catch (error) {
      if (!(error instanceof OrchestrationConflict && error.code === "cleanup-pending")) throw error;
      portable("native-source-busy"); return;
    }
    try {
      const result = await providers.nativeConversation(request, selection,
        { cwd: workspaceKey, sourceCwd: fork.sourceWorkspaceKey, signal, timeoutMs: 30_000 });
      // Revalidate routing and canonical paths after every asynchronous provider operation.
      const after = store.conversation(conversationId);
      const afterRoute = providers.resolveModelRoute(after.modelSelection);
      // A live fork does not hold the source, which may since have moved or been removed; the fork read the
      // native conversation the request names, so only the target's scope decides.
      if (durableJson(modelSelectionSchema.parse(after.modelSelection)) !== durableJson(selection)
        || providerInstanceId(afterRoute.providerId, afterRoute.continuationIdentity) !== boundary.providerInstanceId
        || store.conversationPath(conversationId) !== workspaceKey
        || !live && store.conversationPath(source.id) !== fork.sourceWorkspaceKey) throw new Error("Native fork scope changed.");
      const settled = store.orchestration.nativeControls.settle(effect, result);
      if (settled.state === "uncertain") throw new RuntimeRequestError("Native fork cleanup is still pending.");
    } catch (error) {
      if (store.orchestration.nativeControls.get(operationId)?.state === "running") {
        store.orchestration.nativeControls.uncertain(effect);
      }
      throw error;
    }
  } finally {
    if (sourceReserved) providerTerminalResumes.release(source.id);
    admission?.release();
  }
}
