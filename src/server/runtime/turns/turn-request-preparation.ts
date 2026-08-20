import type { AgentActivity } from "../../../shared/contracts";
import {
  officiallyAllowsFastModeSwitchWithinSession,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
} from "../../../shared/continuation-policy";
import {
  nativeBackendProfile,
  nativeModelSelection,
  modelSelectionSchema,
  routeSupportsNativeFastModeIdentity,
} from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import type { BeginAgentTurnInput } from "../../persistence/types";
import type { ProviderActivityEvent } from "../../provider/contracts";
import { assembleTurnRequest } from "./request-context";
import { previousTurnBoundaryUsage } from "./turn-controller-support";
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

export interface ResolvedTurnRequest {
  input: BeginAgentTurnInput;
  adopt(queued: QueuedTurn): PreparedTurnRequest;
}

/**
 * Resolves a route and atomically persists the immutable request/turn pair.
 * Live stream resources are intentionally attached by the controller only
 * after this durable preparation succeeds.
 */
export function prepareTurnRequest(
  dependencies: PrepareTurnRequestDependencies,
  request: QueueTurnRequest,
  onPersisted?: () => void,
): PreparedTurnRequest {
  const resolved = resolveTurnRequest(dependencies, request);
  const queued = dependencies.store.beginAgentTurn(resolved.input);
  onPersisted?.();
  return resolved.adopt(queued);
}

/**
 * Resolves every mutable route and request input without writing persistence.
 * Batch workflows can resolve both sides first, persist both in one database
 * transaction, and only then adopt live in-memory ownership.
 */
export function resolveTurnRequest(
  dependencies: PrepareTurnRequestDependencies,
  request: QueueTurnRequest,
): ResolvedTurnRequest {
  const conversation = dependencies.store.conversation(request.conversationId);
  const attachments = [...(request.attachments ?? [])];
  const assembled = assembleTurnRequest({
    cwd: dependencies.store.conversationPath(conversation.id),
    visibleContent: request.content,
    interactionMode: conversation.interactionMode,
    attachments,
    imagePaths: request.imagePaths,
    documentContexts: request.documentContexts,
    context: request.context,
    internalInstructions: request.internalInstructions,
  });
  const runId = dependencies.id();
  const turnId = dependencies.id();
  const providerInfo = dependencies.hooks.providerInfo();
  const selectedProvider = providerInfo.find(
    ({ id }) => id === conversation.providerId,
  );
  const requestedModelId = conversation.modelSelection.modelId;
  const selectedModel = requestedModelId !== "provider-default"
    ? selectedProvider?.models.find(({ id }) => id === requestedModelId)
    : selectedProvider?.models.find(({ isDefault }) => isDefault)
      ?? selectedProvider?.models[0];
  const parsedSelection = modelSelectionSchema.parse(conversation.modelSelection);
  const routeSelection = dependencies.hooks.validateModelSelection?.(
    parsedSelection,
  ) ?? parsedSelection;
  const modelSelection = requestedModelId === "provider-default" && selectedModel
    ? nativeModelSelection({
        providerId: conversation.providerId,
        modelId: selectedModel.id,
        alias: selectedModel.label === selectedModel.id
          ? null
          : selectedModel.label,
        reasoningEffort: routeSelection.reasoningEffort
          ?? selectedModel.defaultReasoningEffort
          ?? null,
        providerOptions: routeSelection.providerOptions,
      })
    : routeSelection;
  const route = dependencies.providers.resolveModelRoute(routeSelection);
  const exactProvider = providerInfo.find(({ id }) => id === route.providerId);
  const exactModel = routeSelection.modelId === "provider-default"
    ? exactProvider?.models.find(({ isDefault }) => isDefault)
      ?? exactProvider?.models[0]
    : exactProvider?.models.find(({ id }) => id === routeSelection.modelId);
  const usesNativeCatalog = route.backendProfile.source === "built-in"
    && route.backendProfile.id === nativeBackendProfile(route.providerId).id;
  const externalImageCapability = routeSelection.capabilities.find(
    ({ id }) => id === "images",
  );
  const supportsImages = usesNativeCatalog
    ? exactModel?.inputModalities.includes("image") === true
    : externalImageCapability !== undefined
      && externalImageCapability.state !== "unknown"
      && externalImageCapability.state !== "unavailable";
  const expectedFastMode = route.providerId === "codex"
    ? "priority"
    : route.providerId === "claude"
      ? "fast"
      : null;
  const supportedFastMode = selectedProvider?.id === route.providerId
    && route.backendProfile.id === nativeBackendProfile(route.providerId).id
    && routeSupportsNativeFastModeIdentity(routeSelection)
    && selectedModel?.fastMode?.providerValue === expectedFastMode
    ? expectedFastMode
    : null;
  if ((request.generatedAttachmentPaths?.length ?? 0) > 0) {
    if (!supportsImages) {
      throw new Error(
        "The selected model cannot inspect scanned PDF page images.",
      );
    }
  }
  const latestTurn = dependencies.store.latestAgentTurnForConversation(
    conversation.id,
  );
  const previousContinuationIdentity = latestTurn?.continuationIdentity
    ?? conversation.continuationIdentity
    ?? null;
  const continuation = resolveContinuationDecision({
    previousIdentity: previousContinuationIdentity,
    nextIdentity: route.continuationIdentity,
    previousModelId: routeSelection.modelId === "provider-default"
      ? "provider-default"
      : latestTurn?.modelSelection.modelId
      ?? (conversation.continuationIdentity
        ? routeSelection.modelId
        : null),
    nextModelId: routeSelection.modelId,
    hasProviderSession: conversation.providerSessionId !== null,
    hasTurns: latestTurn !== null,
    allowsModelSwitchWithinSession:
      officiallyAllowsModelSwitchWithinSession(route.compatibility),
    allowsPerformanceModeSwitchWithinSession:
      officiallyAllowsFastModeSwitchWithinSession(route.compatibility)
      && supportedFastMode !== null,
  });
  if (continuation.action === "new-conversation-required") {
    throw new Error(continuation.reason);
  }
  const canResume = continuation.action === "resume-session";
  const goalContinuationExpected = request.goalStart !== undefined
    || dependencies.store.agentGoals(conversation.id).some((goal) =>
      goal.source === "codex-native"
      && goal.providerSessionId === conversation.providerSessionId
      && goal.status === "active");
  const providerInput = {
    providerId: route.providerId,
    harnessId: route.harnessId,
    backendProfile: route.backendProfile,
    backendCompatibility: route.compatibility,
    modelSelection: routeSelection,
    continuationIdentity: route.continuationIdentity,
    conversationId: conversation.id,
    runId,
    turnId,
    cwd: dependencies.store.conversationPath(conversation.id),
    prompt: assembled.executionPrompt,
    model: routeSelection.modelId === "provider-default"
      ? undefined
      : routeSelection.modelId,
    reasoningEffort: routeSelection.reasoningEffort || undefined,
    interactionMode: conversation.interactionMode,
    access: conversation.accessMode,
    sessionId: canResume ? conversation.providerSessionId! : undefined,
    ...(supportedFastMode ? { supportedFastMode } : {}),
    ...(canResume
      && previousContinuationIdentity
      && (previousContinuationIdentity.performanceModeIdentity ?? null)
        !== (route.continuationIdentity.performanceModeIdentity ?? null)
      ? {
          performanceModeTransition: modelSelection.providerOptions.fastMode
            ? "to-fast" as const
            : "to-standard" as const,
        }
      : {}),
    imagePaths: assembled.imagePaths,
    skills: request.skills,
    ...(request.goalStart ? { goalStart: request.goalStart } : {}),
    ...(goalContinuationExpected ? { goalContinuationExpected: true } : {}),
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
  const input: BeginAgentTurnInput = {
    id: turnId,
    conversationId: conversation.id,
    runId,
    content: assembled.visibleContent,
    attachments,
    activateConversation: request.activateConversation,
    executionContext: assembled.persistence,
    ...(request.context?.conversationContextPacketIds?.length
      ? {
          conversationContextPacketIds:
            request.context.conversationContextPacketIds,
          contextRequestId: request.contextRequestId,
        }
      : {}),
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
    usageAtStart: canResume
      ? previousTurnBoundaryUsage(latestTurn, conversation.providerSessionId!)
      : null,
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: "authoritative",
  };
  return {
    input,
    adopt: (queued) => {
      const runningActivities =
        new Map<ProviderActivityEvent["kind"], AgentActivity[]>();
      return {
        queued,
        active: {
          turn: queued.turn,
          conversation,
          providerInput,
          attachmentIds: attachments.map(({ id }) => id),
          generatedAttachmentPaths: [...(request.generatedAttachmentPaths ?? [])],
          checkpointId: request.checkpointId ?? null,
          rendererOwnerId: request.rendererOwnerId ?? null,
          structuredContext,
          gitBeforeCapture: null,
          runStartedAt: dependencies.clock().getTime(),
          workspaceRunCreated: false,
          providerRunStarted: false,
          providerStartAcknowledgement: null,
          nativeGoalStartAcknowledgement: null,
          attachmentsReleased: false,
          attachmentRelease: null,
          followUpAdmissions: new Set<Promise<void>>(),
          followUpAdmissionTail: Promise.resolve(),
          supportsFollowUpImages: Boolean(supportsImages),
          acceptingProviderEvents: true,
          settled: false,
          sessionAfter: canResume ? conversation.providerSessionId : null,
          lastUsage: null,
          assistantText: "",
          assistantPendingHighSurrogate: "",
          assistantSegmentText: "",
          assistantMessageId: null,
          latestAssistantMessageId: null,
          reasoningText: "",
          reasoningPendingHighSurrogate: "",
          reasoningId: null,
          timeoutTimer: null,
          lifetimeTimer: null,
          runningActivities,
          providerActivitiesById: new Map<string, AgentActivity>(),
          providerActivityDetailChars: 0,
          providerCommandRuns: new Map<string, string>(),
          approvalIds: new Set<string>(),
          inputIds: new Set<string>(),
          onSettled: request.onSettled,
        },
      };
    },
  };
}
