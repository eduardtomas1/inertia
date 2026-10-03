import type { AgentActivity } from "../../../shared/contracts";
import {
  officiallyAllowsFastModeSwitchWithinSession,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
  staleProviderSessionDecision,
} from "../../../shared/continuation-policy";
import {
  modelSelectionHasVerifiedProbeCapability,
  modelSelectionSchema,
  providerNativeBackendProfile,
  providerNativeModelSelection,
  routeSupportsNativeFastModeIdentity,
} from "../../../shared/model-routing";
import { NATIVE_ANTHROPIC_PROFILE_ID } from "../../../shared/claude-backend-profiles";
import type { RuntimeStore } from "../../database";
import type { BeginAgentTurnInput } from "../../persistence/types";
import type {
  ProviderActivityEvent,
} from "../../provider/contracts";
import { AuthoritativeRunStateEngine } from "../run-state-engine";
import {
  assembleTurnRequest,
  type AssembleTurnRequestInput,
  type ConversationContextMaterialization,
} from "./request-context";
import { previousTurnBoundaryUsage } from "./turn-controller-support";
import { routeUsesTrustedHostBridge } from "./turn-provider-host-tools";
import type {
  ActiveTurn,
  QueuedTurn,
  QueueTurnRequest,
  TurnControllerHooks,
  TurnProviderRuntime,
} from "./turn-controller-types";

const CUSTOM_BACKEND_RESTORED_HISTORY_BYTES = 48 * 1_024;

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

export function prepareTurnRequest(
  dependencies: PrepareTurnRequestDependencies,
  request: QueueTurnRequest,
  onPersisted?: () => void,
  onAdoptionFailure?: (queued: QueuedTurn, error: unknown) => void,
): PreparedTurnRequest {
  const resolved = resolveTurnRequest(dependencies, request);
  const queued = dependencies.store.beginAgentTurn(resolved.input);
  try {
    onPersisted?.();
    return resolved.adopt(queued);
  } catch (error) {
    onAdoptionFailure?.(queued, error);
    throw error;
  }
}

export function resolveTurnRequest(
  dependencies: PrepareTurnRequestDependencies,
  request: QueueTurnRequest,
): ResolvedTurnRequest {
  const conversation = dependencies.store.conversation(request.conversationId);
  const attachments = [...(request.attachments ?? [])];
  const providerInfo = dependencies.hooks.providerInfo();
  const selectedProvider = providerInfo.find(
    ({ id }) => id === conversation.providerId,
  );
  const runId = dependencies.id();
  const turnId = dependencies.id();
  const requestedModelId = conversation.modelSelection.modelId;
  const selectedModel = requestedModelId !== "provider-default"
    ? selectedProvider?.models.find(({ id }) => id === requestedModelId)
    : selectedProvider?.models.find(({ isDefault }) => isDefault)
      ?? selectedProvider?.models[0];
  const parsedSelection = modelSelectionSchema.parse(conversation.modelSelection);
  const routeSelection = dependencies.hooks.validateModelSelection?.(
    parsedSelection,
  ) ?? parsedSelection;
  const modelSelection = requestedModelId === "provider-default"
    && selectedModel
    ? providerNativeModelSelection({
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
  dependencies.store.assertConversationProvider(conversation.id, route.providerId);
  const exactProvider = providerInfo.find(({ id }) => id === route.providerId);
  const capabilityContract = exactProvider?.capabilityContract;
  const hostToolBridgeAttested = capabilityContract !== undefined
    && capabilityContract.installationVerified
    && capabilityContract.hostToolBridgeAvailable
    && capabilityContract.harnessId === route.harnessId
    && routeUsesTrustedHostBridge({
      providerId: route.providerId,
      harnessId: route.harnessId,
      backendProfile: route.backendProfile,
    });
  const capabilityInstructions = hostToolBridgeAttested
    ? dependencies.hooks.harnessInstructionsForTurn?.({ conversation }) ?? []
    : [];

  const exactModel = routeSelection.modelId === "provider-default"
    ? exactProvider?.models.find(({ isDefault }) => isDefault)
      ?? exactProvider?.models[0]
    : exactProvider?.models.find(({ id }) => id === routeSelection.modelId);
  const usesNativeCatalog = route.backendProfile.source === "built-in"
    && route.backendProfile.id === providerNativeBackendProfile(route.providerId).id;
  const supportsImages = usesNativeCatalog
    ? exactModel?.inputModalities.includes("image") === true
    : modelSelectionHasVerifiedProbeCapability(routeSelection, "images");
  const expectedFastMode = route.providerId === "codex"
    ? "priority"
    : route.providerId === "claude"
      ? "fast"
      : null;
  const supportedFastMode = selectedProvider?.id === route.providerId
    && route.backendProfile.id === providerNativeBackendProfile(route.providerId).id
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
  const latestTurnOwnsProviderSession = latestTurn !== null
    && conversation.providerSessionId !== null
    && latestTurn.providerSessionAfter === conversation.providerSessionId;
  const previousContinuationIdentity = latestTurn
    ? latestTurnOwnsProviderSession
      ? latestTurn.continuationIdentity
      : null
    : conversation.continuationIdentity ?? null;
  const previousContinuationModelId = previousContinuationIdentity
    ? routeSelection.modelId === "provider-default"
      ? "provider-default"
      : latestTurn
        ? latestTurn.modelSelection.modelId
        : routeSelection.modelId
    : null;
  const resolvedContinuation = resolveContinuationDecision({
    previousIdentity: previousContinuationIdentity,
    nextIdentity: route.continuationIdentity,
    previousModelId: previousContinuationModelId,
    nextModelId: routeSelection.modelId,
    hasProviderSession: conversation.providerSessionId !== null,
    hasTurns: latestTurn !== null,
    allowsModelSwitchWithinSession:
      officiallyAllowsModelSwitchWithinSession(route.compatibility),
    allowsPerformanceModeSwitchWithinSession:
      officiallyAllowsFastModeSwitchWithinSession(route.compatibility)
      && supportedFastMode !== null,
  });
  if (resolvedContinuation.action === "new-conversation-required") {
    throw new Error(resolvedContinuation.reason);
  }
  const continuation = resolvedContinuation.action === "resume-session"
    && latestTurn?.status === "failed"
    && dependencies.store.cliConversationImportProvider(conversation.id) === null
    && dependencies.store.turnLedgerRepository.savedSessionKeepsFailing(
      conversation.id,
      conversation.providerSessionId!,
    )
    ? staleProviderSessionDecision()
    : resolvedContinuation;
  const contextPacketIds = request.context?.conversationContextPacketIds ?? [];
  const requestedAt = dependencies.now();
  let conversationContexts: ConversationContextMaterialization | undefined;
  const assemblyInput = {
    ...(contextPacketIds.length > 0
      ? {
          conversationContexts: (capacityBytes: number) => conversationContexts
            ??= dependencies.store.contextPackets
              .materialize(conversation.id, contextPacketIds, capacityBytes),
        }
      : {}),
    cwd: dependencies.store.conversationPath(conversation.id),
    visibleContent: request.content,
    interactionMode: conversation.interactionMode,
    attachments,
    imagePaths: request.imagePaths,
    documentContexts: request.documentContexts,
    context: request.context,
    internalInstructions: [
      ...capabilityInstructions,
      ...(request.internalInstructions ?? []),
    ],
  } satisfies AssembleTurnRequestInput;
  const referencesOwnChat = dependencies.store.contextPackets
    .includesOwnConversation(conversation.id, contextPacketIds);
  const unattributedHistoryOnRoute = () => {
    const { backendProfileId, endpointIdentity } = route.continuationIdentity;
    const shell = conversation.continuationIdentity;
    const turns = dependencies.store.turnLedgerRepository.historyStayedOnEndpoint(
      conversation.id,
      backendProfileId,
      endpointIdentity,
    );
    return turns.stayed && (shell
      ? shell.backendProfileId === backendProfileId && shell.endpointIdentity === endpointIdentity
      : turns.turnCount > 0);
  };
  const assembleOnFreshSession = (excludedMessageId?: string) => {
    const fresh = assembleTurnRequest({
      ...assemblyInput,
      ...(!referencesOwnChat
        ? {
            restoredHistory: (capacityBytes: number) => dependencies.store.continuationHistory(
              conversation.id,
              usesNativeCatalog
                ? capacityBytes
                : Math.min(capacityBytes, CUSTOM_BACKEND_RESTORED_HISTORY_BYTES),
              requestedAt,
              excludedMessageId,
              {
                backendProfileId: route.continuationIdentity.backendProfileId,
                endpointIdentity: route.continuationIdentity.endpointIdentity,
                includeUnattributed: unattributedHistoryOnRoute(),
              },
            ),
          }
        : {}),
    });
    return {
      ...fresh,
      sessionRecovery: fresh.sessionRecovery ?? (referencesOwnChat
        ? { restoredMessageCount: 0, omittedMessageCount: 0 }
        : null),
    };
  };
  const canResume = continuation.action === "resume-session";
  const startsFreshInEstablishedChat = !canResume
    && continuation.reasonCode !== "first-turn"
    && request.goalStart === undefined;
  const assembled = startsFreshInEstablishedChat
    ? assembleOnFreshSession()
    : assembleTurnRequest(assemblyInput);
  const providerSessionInvalidation = !canResume && conversation.providerSessionId
    ? { expectedSessionId: conversation.providerSessionId }
    : undefined;
  const goalContinuationExpected = request.goalStart !== undefined
    || (canResume && dependencies.store.agentGoals(conversation.id).some((goal) =>
      goal.source === "codex-native"
      && goal.providerSessionId === conversation.providerSessionId
      && goal.status === "active"));
  const maxBudgetUsd = route.providerId === "claude"
    && route.harnessId === "claude-agent-sdk"
    && route.backendProfile.id === NATIVE_ANTHROPIC_PROFILE_ID
    ? dependencies.store.project(conversation.projectId).preferences
      ?.claudeMaxBudgetUsd ?? null
    : null;
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
    attachmentReadRoots: dependencies.hooks.attachmentReadRoots?.({
      conversationId: conversation.id,
      attachmentIds: attachments.map(({ id }) => id),
    }) ?? [],
    skills: request.skills,
    ...(request.goalStart ? { goalStart: request.goalStart } : {}),
    ...(goalContinuationExpected ? { goalContinuationExpected: true } : {}),
    ...(maxBudgetUsd !== null ? { maxBudgetUsd } : {}),
  } satisfies ActiveTurn["providerInput"];
  const harnessId = dependencies.providers.harnessIdFor(providerInput);
  if (harnessId !== route.harnessId) {
    throw new Error(
      "The resolved model route changed before the turn could start.",
    );
  }
  const structuredContext = dependencies.hooks.captureStructuredContext?.({
    conversation,
    content: assembled.visibleContent,
    attachments,
    executionManifest: assembled.persistence.manifest,
  });
  const input: BeginAgentTurnInput = {
    queuedMessageId: request.queuedMessageId,
    limitResetPlanId: request.limitResetPlanId,
    id: turnId,
    conversationId: conversation.id,
    runId,
    content: assembled.visibleContent,
    attachments,
    activateConversation: request.activateConversation,
    privateConnectDeviceId: request.privateConnectDeviceId,
    executionContext: assembled.persistence,
    ...(contextPacketIds.length > 0
      ? {
          conversationContextPacketIds: contextPacketIds,
          conversationContextDeliveries: assembled.conversationContextDeliveries,
          contextRequestId: request.contextRequestId,
        }
      : {}),
    providerId: route.providerId,
    modelSelection,
    continuationIdentity: route.continuationIdentity,
    continuationReasonCode: continuation.reasonCode,
    sessionRecovery: assembled.sessionRecovery,
    harnessId,
    backendProfileId: modelSelection.backendProfileId,
    model: modelSelection.modelId,
    modelAlias: modelSelection.alias,
    reasoningEffort: modelSelection.reasoningEffort ?? "",
    interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode,
    providerSessionBefore: canResume ? conversation.providerSessionId : null,
    ...(providerSessionInvalidation ? { providerSessionInvalidation } : {}),
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
      const activeConversation = providerSessionInvalidation
        ? {
            ...conversation,
            providerSessionId: null,
            continuationIdentity: null,
          }
        : conversation;
      return {
        queued,
        active: {
          turn: queued.turn,
          conversation: activeConversation,
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
          runState: new AuthoritativeRunStateEngine({
            conversationId: conversation.id,
            runId: queued.turn.runId,
            turnId: queued.turn.id,
            providerId: route.providerId,
          }),
          deferredSettlement: null,
          providerStopStarted: false,
          sessionAfter: canResume ? conversation.providerSessionId : null,
          freshSessionRequest: canResume && request.goalStart === undefined
            ? assembleOnFreshSession
            : null,
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
