import type { AgentActivity } from "../../../shared/contracts";
import { resolveContinuationDecision } from "../../../shared/continuation-policy";
import { modelSelectionSchema } from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import type { ProviderActivityEvent } from "../../provider/contracts";
import { assembleTurnRequest } from "./request-context";
import { boundaryUsage } from "./turn-controller-support";
import type {
  ActiveTurn,
  QueuedTurn,
  QueueTurnRequest,
  TurnControllerHooks,
  TurnProviderRuntime,
} from "./turn-controller-types";

export type PreparedActiveTurn = Omit<
  ActiveTurn,
  "assistantStream" | "reasoningStream"
>;

export interface PrepareTurnRequestDependencies {
  store: RuntimeStore;
  providers: TurnProviderRuntime;
  hooks: TurnControllerHooks;
  id(): string;
  now(): string;
  clock(): Date;
}

export interface PreparedTurnRequest {
  queued: QueuedTurn;
  active: PreparedActiveTurn;
}

/**
 * Resolves a route and atomically persists the immutable request/turn pair.
 * Live stream resources are intentionally attached by the controller only
 * after this durable preparation succeeds.
 */
export function prepareTurnRequest(
  dependencies: PrepareTurnRequestDependencies,
  request: QueueTurnRequest,
): PreparedTurnRequest {
  const conversation = dependencies.store.conversation(request.conversationId);
  const attachments = [...(request.attachments ?? [])];
  const assembled = assembleTurnRequest({
    cwd: dependencies.store.conversationPath(conversation.id),
    visibleContent: request.content,
    interactionMode: conversation.interactionMode,
    attachments,
    imagePaths: request.imagePaths,
    context: request.context,
    internalInstructions: request.internalInstructions,
  });
  const runId = dependencies.id();
  const turnId = dependencies.id();
  const selectedProvider = dependencies.hooks.providerInfo()
    .find(({ id }) => id === conversation.providerId);
  const requestedModelId = conversation.modelSelection.modelId;
  const selectedModel = requestedModelId !== "provider-default"
    ? selectedProvider?.models.find(({ id }) => id === requestedModelId)
    : selectedProvider?.models.find(({ isDefault }) => isDefault)
      ?? selectedProvider?.models[0];
  const modelSelection = modelSelectionSchema.parse({
    ...conversation.modelSelection,
    modelId: selectedModel?.id ?? requestedModelId,
  });
  const route = dependencies.providers.resolveModelRoute(modelSelection);
  const latestTurn = dependencies.store.latestAgentTurnForConversation(
    conversation.id,
  );
  const continuation = resolveContinuationDecision({
    previousIdentity: latestTurn?.continuationIdentity
      ?? conversation.continuationIdentity
      ?? null,
    nextIdentity: route.continuationIdentity,
    previousModelId: latestTurn?.modelSelection.modelId
      ?? (conversation.continuationIdentity
        ? conversation.modelSelection.modelId
        : null),
    nextModelId: modelSelection.modelId,
    hasProviderSession: conversation.providerSessionId !== null,
    hasTurns: latestTurn !== null,
    allowsModelSwitchWithinSession:
      route.compatibility.allowsModelSwitchWithinSession,
  });
  if (continuation.action === "new-conversation-required") {
    throw new Error(continuation.reason);
  }
  const canResume = continuation.action === "resume-session";
  const providerInput = {
    providerId: route.providerId,
    harnessId: route.harnessId,
    backendProfile: route.backendProfile,
    backendCompatibility: route.compatibility,
    modelSelection,
    continuationIdentity: route.continuationIdentity,
    conversationId: conversation.id,
    runId,
    turnId,
    cwd: dependencies.store.conversationPath(conversation.id),
    prompt: assembled.executionPrompt,
    model: modelSelection.modelId === "provider-default"
      ? undefined
      : modelSelection.modelId,
    reasoningEffort: modelSelection.reasoningEffort || undefined,
    interactionMode: conversation.interactionMode,
    access: conversation.accessMode,
    sessionId: canResume ? conversation.providerSessionId! : undefined,
    imagePaths: assembled.imagePaths,
  } satisfies ActiveTurn["providerInput"];
  const harnessId = dependencies.providers.harnessIdFor(providerInput);
  if (harnessId !== route.harnessId) {
    throw new Error(
      "The resolved model route changed before the turn could start.",
    );
  }
  const requestedAt = dependencies.now();
  const structuredContext = dependencies.hooks.captureStructuredContext?.({
    conversation,
    content: assembled.visibleContent,
    attachments,
    executionManifest: assembled.persistence.manifest,
  });
  const currentUsage = dependencies.store.usageForConversation(conversation.id);
  const queued = dependencies.store.beginAgentTurn({
    id: turnId,
    conversationId: conversation.id,
    runId,
    content: assembled.visibleContent,
    attachments,
    activateConversation: request.activateConversation,
    executionContext: assembled.persistence,
    providerId: route.providerId,
    modelSelection,
    continuationIdentity: route.continuationIdentity,
    harnessId,
    backendProfileId: modelSelection.backendProfileId,
    model: modelSelection.modelId,
    modelAlias: modelSelection.alias,
    reasoningEffort: modelSelection.reasoningEffort ?? "",
    interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode,
    providerSessionBefore: canResume ? conversation.providerSessionId : null,
    requestedAt,
    usageAtStart: boundaryUsage(currentUsage ?? undefined, requestedAt),
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: "authoritative",
  });
  const runningActivities =
    new Map<ProviderActivityEvent["kind"], AgentActivity[]>();
  return {
    queued,
    active: {
      turn: queued.turn,
      conversation,
      providerInput,
      attachmentIds: attachments.map(({ id }) => id),
      checkpointId: request.checkpointId ?? null,
      rendererOwnerId: request.rendererOwnerId ?? null,
      structuredContext,
      gitBeforeCapture: null,
      runStartedAt: dependencies.clock().getTime(),
      workspaceRunCreated: false,
      providerRunStarted: false,
      attachmentsReleased: false,
      attachmentRelease: null,
      acceptingProviderEvents: true,
      settled: false,
      sessionAfter: canResume ? conversation.providerSessionId : null,
      lastUsage: null,
      assistantText: "",
      assistantSegmentText: "",
      assistantMessageId: null,
      latestAssistantMessageId: null,
      reasoningText: "",
      reasoningId: null,
      timeoutTimer: null,
      runningActivities,
      providerActivitiesById: new Map<string, AgentActivity>(),
      providerActivityDetailChars: 0,
      providerCommandRuns: new Map<string, string>(),
      approvalIds: new Set<string>(),
      inputIds: new Set<string>(),
      onSettled: request.onSettled,
    },
  };
}
