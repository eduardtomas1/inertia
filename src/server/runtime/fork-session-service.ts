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
  let source;
  try { source = store.conversation(fork.parentThreadId); }
  catch (error) { if (!(error instanceof RecordNotFoundError)) throw error; portable("source-removed"); return; }
  if (source.projectId !== target.projectId || source.providerId !== route.providerId
    || store.conversationPath(source.id) !== fork.sourceWorkspaceKey
    || store.orchestration.hasPendingCleanup(source.id) || providers.isRunning(source.id)) {
    portable("native-source-unavailable");
    return;
  }
  signal.throwIfAborted();
  const admission = await turns.acquireTurnAdmission(source.id, 100);
  if (!admission) { portable("native-source-busy"); return; }
  let sourceReserved = false;
  try {
    signal.throwIfAborted();
    sourceReserved = providerTerminalResumes.acquire(source.id);
    if (!sourceReserved) { portable("native-source-busy"); return; }
    const current = store.conversation(conversationId);
    const selection = modelSelectionSchema.parse(current.modelSelection);
    const currentRoute = providers.resolveModelRoute(selection);
    if (current.projectId !== fork.projectId
      || providerInstanceId(currentRoute.providerId, currentRoute.continuationIdentity) !== boundary.providerInstanceId
      || store.conversationPath(source.id) !== fork.sourceWorkspaceKey) {
      portable("native-route-changed"); return;
    }
    const expectedHeadId = store.orchestration.history.physicalHead({ threadId: source.id,
      providerInstanceId: boundary.providerInstanceId, workspaceKey: fork.sourceWorkspaceKey,
      nativeConversationId: boundary.nativeConversationId });
    if (expectedHeadId === null) { portable("native-head-unavailable"); return; }
    const workspaceKey = store.conversationPath(conversationId);
    const operationId = randomUUID();
    const request = { kind: "fork" as const, operationId, targetConversationId: conversationId,
      source: { identity: { projectId: fork.projectId, conversationId: source.id,
        workspaceId: commandFingerprint({ projectId: fork.projectId, workspaceKey: fork.sourceWorkspaceKey }),
        repositoryId: store.project(fork.projectId).repositoryIdentity,
        providerInstanceId: boundary.providerInstanceId }, nativeConversationId: boundary.nativeConversationId,
        ...(boundary.nativeSessionId === null ? {} : { nativeSessionId: boundary.nativeSessionId }), expectedHeadId },
      boundary: { kind: "turn" as const, nativeTurnId: boundary.nativeTurnId } };
    const effect = store.orchestration.nativeControls.start({ id: operationId, threadId: conversationId,
      projectId: fork.projectId, request, sourceWorkspaceKey: fork.sourceWorkspaceKey,
      targetWorkspaceKey: workspaceKey, selection,
      continuationIdentity: versionedContinuationIdentitySchema.parse(currentRoute.continuationIdentity) });
    try {
      const result = await providers.nativeConversation(request, selection,
        { cwd: workspaceKey, sourceCwd: fork.sourceWorkspaceKey, signal, timeoutMs: 30_000 });
      // Revalidate routing and canonical paths after every asynchronous provider operation.
      const after = store.conversation(conversationId);
      const afterRoute = providers.resolveModelRoute(after.modelSelection);
      if (durableJson(modelSelectionSchema.parse(after.modelSelection)) !== durableJson(selection)
        || providerInstanceId(afterRoute.providerId, afterRoute.continuationIdentity) !== boundary.providerInstanceId
        || store.conversationPath(conversationId) !== workspaceKey
        || store.conversationPath(source.id) !== fork.sourceWorkspaceKey) throw new Error("Native fork scope changed.");
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
    admission.release();
  }
}
