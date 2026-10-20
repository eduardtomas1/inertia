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
import {
  clampAccessMode,
  initiativeAccessCeilingMessage,
  providerExceedsAccessLimit,
  UNSUPERVISED_PROVIDER_LIMIT_REASON,
} from "../../../shared/access-modes";
import { effectiveClaudeBudget } from "../../../shared/initiatives";
import { importedFollowUpNote, importedResumeCwd, importedSession } from "../../cli-import/resume-cwd";
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
import { initiativeTurnContext, type InitiativeTurnContext } from "./initiative-turn-context";
import { previousTurnBoundaryUsage } from "./turn-controller-support";
import { PROVIDER_INFO } from "../../provider/catalog";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  runtimeInterruptionInstruction,
  sharesInterruptionEndpoint,
} from "./turn-runtime-interruption-note";
import { routeUsesTrustedHostBridge } from "./turn-provider-host-tools";
import { broadcastConversationShell } from "./turn-controller-support";
import type {
  ActiveTurn,
  FreshSessionTurnRequest,
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
  importNote: string | null;
  handoffFromTurnId: string | null;
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
    if (queued.initiativeContextReceipt) {
      dependencies.hooks.broadcast({
        type: "conversation.message.persisted",
        message: queued.initiativeContextReceipt,
      });
    }
    if (queued.accessLowered) broadcastConversationShell(dependencies.hooks, queued.turn.conversationId);
    if (resolved.handoffFromTurnId) {
      retireUsageLimitSnooze(dependencies, queued.turn.conversationId, resolved.handoffFromTurnId);
    }
    if (resolved.importNote) {
      const message = dependencies.store.createMessage(queued.turn.conversationId, resolved.importNote, "system", [], queued.turn.id, undefined, { activateConversation: false });
      dependencies.hooks.broadcast({ type: "conversation.message.persisted", message });
    }
    onPersisted?.();
    return resolved.adopt(queued);
  } catch (error) {
    onAdoptionFailure?.(queued, error);
    throw error;
  }
}

function retireUsageLimitSnooze(
  dependencies: PrepareTurnRequestDependencies,
  conversationId: string,
  limitedTurnId: string,
): void {
  const { snoozedUntil } = dependencies.store.conversation(conversationId);
  if (!snoozedUntil || Date.parse(snoozedUntil) <= dependencies.clock().getTime()) return;
  if (dependencies.store.agentTurn(limitedTurnId).status !== "failed") return;
  if (!dependencies.store.limitResets.usageLimited(limitedTurnId)) return;
  dependencies.store.updateConversation(conversationId, { snoozedUntil: null });
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
  // The provider's access is fixed for the whole turn, so the initiative's
  // access limit is applied here: the turn never runs above it, even when the
  // chat's stored access is (restored or racing data, which the turn's
  // persistence then lowers). A provider that cannot stay within the limit,
  // such as Antigravity under a Supervised limit, is refused.
  const initiativePreferences = dependencies.store.initiativePreferencesFor(conversation);
  const accessLimit = initiativePreferences?.accessCeiling ?? null;
  const accessMode = clampAccessMode(conversation.accessMode, accessLimit);
  if (accessLimit && providerExceedsAccessLimit(route.providerId, accessMode, accessLimit)) {
    const name = dependencies.store.initiatives.get(conversation.initiativeId!)?.name ?? "This initiative";
    throw new RuntimeRequestError(
      `${initiativeAccessCeilingMessage(name, accessLimit)} ${UNSUPERVISED_PROVIDER_LIMIT_REASON}`,
    );
  }
  const turnConversation = accessMode === conversation.accessMode
    ? conversation
    : { ...conversation, accessMode };
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
  if (
    request.goalStart !== undefined
    && latestTurn !== null
    && latestTurn.providerId !== route.providerId
  ) {
    throw new RuntimeRequestError(
      `Send a message first so ${PROVIDER_INFO[route.providerId].name} receives this chat's earlier messages.`,
    );
  }
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
    ...(latestTurn ? { previousProviderId: latestTurn.providerId } : {}),
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
  const continuation = resolvedContinuation.action === "resume-session"
    && latestTurn?.status === "failed"
    && importedSession(dependencies.store, conversation.id, conversation.providerSessionId) === null
    && dependencies.store.turnLedgerRepository.savedSessionKeepsFailing(
      conversation.id,
      conversation.providerSessionId!,
    )
    ? staleProviderSessionDecision()
    : resolvedContinuation;
  const resumesImportedCodex = continuation.action === "resume-session" && route.providerId === "codex"
    && importedSession(dependencies.store, conversation.id, conversation.providerSessionId) !== null;
  const contextPacketIds = request.context?.conversationContextPacketIds ?? [];
  const interruptedTurnId = dependencies.store.turnLedgerRepository
    .runtimeInterruptionSource(conversation.id);
  const requestedAt = dependencies.now();
  const canResume = continuation.action === "resume-session";
  // The initiative's brief and notes index: in full on a fresh provider
  // session, and afterwards only when a part changed since this session last
  // received it.
  const initiativeContext = initiativeTurnContext(dependencies.store, conversation, {
    freshSession: !canResume,
  });
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
      ...(resumesImportedCodex ? [] : capabilityInstructions),
      ...(interruptedTurnId === null ? [] : [runtimeInterruptionInstruction(
        sharesInterruptionEndpoint(
          dependencies.store.agentTurn(interruptedTurnId).continuationIdentity,
          route.continuationIdentity,
        )
          ? dependencies.store.turnLedgerRepository.runtimeInterruption(interruptedTurnId)
          : null,
      )]),
      ...(request.internalInstructions ?? []),
    ],
  } satisfies AssembleTurnRequestInput;
  /**
   * The one place a request is assembled with its initiative material. Both
   * the turn's own request and a fresh-session fallback return the record of
   * what they carried, which is what the ledger writes.
   */
  const assemble = (
    initiative: InitiativeTurnContext | null,
    extra: Pick<AssembleTurnRequestInput, "restoredHistory" | "carriedConversationContexts">,
  ): FreshSessionTurnRequest => ({
    ...assembleTurnRequest({
      ...assemblyInput,
      ...extra,
      ...(initiative
        ? {
            initiativeContexts: initiative.contexts,
            internalInstructions: [...assemblyInput.internalInstructions, initiative.instruction],
          }
        : {}),
    }),
    initiativeContext: initiative?.record ?? null,
  });
  const ownChatPacketId = dependencies.store.contextPackets
    .ownConversationPacketId(conversation.id, contextPacketIds);
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
  // A provider handoff carries the chat's earlier messages to the new
  // provider. Later fresh sessions on that route keep what the handoff carried,
  // but messages produced afterwards on other routes stay withheld.
  const providerHandoff = continuation.reasonCode === "harness-changed"
    && latestTurn !== null
    && latestTurn.providerId !== route.providerId;
  const restoredHistoryRoute = () => {
    const { backendProfileId, endpointIdentity } = route.continuationIdentity;
    const handoffBefore = providerHandoff
      ? requestedAt
      : dependencies.store.turnLedgerRepository.latestProviderHandoffOnRoute(
          conversation.id,
          backendProfileId,
          endpointIdentity,
        )?.requestedAt;
    return {
      backendProfileId,
      endpointIdentity,
      includeUnattributed: unattributedHistoryOnRoute(),
      ...(handoffBefore === undefined
        ? {}
        : { handoff: { before: handoffBefore, providerId: route.providerId } }),
    };
  };
  const restoredCapacity = (capacityBytes: number) => usesNativeCatalog
    ? capacityBytes
    : Math.min(capacityBytes, CUSTOM_BACKEND_RESTORED_HISTORY_BYTES);
  const referencedHistory = (capacityBytes: number) => {
    const delivery = conversationContexts?.deliveries
      .find(({ packetId }) => packetId === ownChatPacketId);
    return dependencies.store.transcriptRepository.referencedContinuationHistory(
      conversation.id,
      restoredCapacity(capacityBytes),
      restoredHistoryRoute(),
      {
        messageCount: delivery?.messageCount ?? 0,
        omittedMessageCount: delivery?.omittedMessageCount ?? 0,
      },
    );
  };
  const assembleOnFreshSession = (initiative: InitiativeTurnContext | null, excludedMessageId?: string) =>
    assemble(initiative, {
      restoredHistory: ownChatPacketId === null
        ? (capacityBytes: number) => dependencies.store.continuationHistory(
            conversation.id,
            restoredCapacity(capacityBytes),
            requestedAt,
            excludedMessageId,
            restoredHistoryRoute(),
          )
        : referencedHistory,
    });
  // A resumed turn that falls back to a fresh session sends everything again,
  // read from the chat as it is when the fallback happens: it may have moved
  // to another initiative, or left one, since this request was prepared.
  const assembleFallback = (excludedMessageId: string) => assembleOnFreshSession(
    initiativeTurnContext(dependencies.store, dependencies.store.conversation(conversation.id), {
      freshSession: true,
    }),
    excludedMessageId,
  );
  const importNote = latestTurn?.origin === "cli-import"
    ? importedFollowUpNote(dependencies.store.cliConversationImport(conversation.id), canResume && importedSession(dependencies.store, conversation.id, conversation.providerSessionId) !== null)
    : null;
  const startsFreshInEstablishedChat = !canResume
    && continuation.reasonCode !== "first-turn"
    && request.goalStart === undefined;
  const assembled = startsFreshInEstablishedChat
    ? assembleOnFreshSession(initiativeContext)
    : assemble(initiativeContext, {
        carriedConversationContexts: dependencies.store.contextPackets
          .unreachedReferences(conversation.id)
          .flatMap((reference) => reference.sentBlocks() ?? []),
      });
  const providerSessionInvalidation = !canResume && conversation.providerSessionId
    ? { expectedSessionId: conversation.providerSessionId }
    : undefined;
  const goalContinuationExpected = request.goalStart !== undefined
    || (canResume && dependencies.store.agentGoals(conversation.id).some((goal) =>
      goal.source === "codex-native"
      && goal.providerSessionId === conversation.providerSessionId
      && goal.status === "active"));
  // The lower of the initiative's and the project's limits; an initiative
  // restriction holds whatever the initiative's status.
  const maxBudgetUsd = route.providerId === "claude"
    && route.harnessId === "claude-agent-sdk"
    && route.backendProfile.id === NATIVE_ANTHROPIC_PROFILE_ID
    ? effectiveClaudeBudget(
        initiativePreferences,
        dependencies.store.project(conversation.projectId).preferences,
      ).usd
    : null;
  // Selected Claude skills may come from the initiative's skills folder; the
  // harness revalidates them against this contained root when staging.
  const initiativeSkillsRoot = request.skills?.some(({ source }) => source === "claude-native")
    ? dependencies.hooks.initiativeSkillsRoot?.(conversation) ?? null
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
    cwd: canResume
      ? importedResumeCwd(dependencies.store, conversation.id, conversation.providerSessionId, dependencies.store.conversationPath(conversation.id))
      : dependencies.store.conversationPath(conversation.id),
    prompt: assembled.executionPrompt,
    model: routeSelection.modelId === "provider-default"
      ? undefined
      : routeSelection.modelId,
    reasoningEffort: routeSelection.reasoningEffort || undefined,
    interactionMode: conversation.interactionMode,
    access: accessMode,
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
    ...(initiativeSkillsRoot ? { initiativeSkillsRoot } : {}),
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
    restartContinuationPlanId: request.restartContinuationPlanId,
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
    ...(assembled.initiativeContext ? { initiativeContext: assembled.initiativeContext } : {}),
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
    accessMode,
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
    importNote,
    handoffFromTurnId: providerHandoff ? latestTurn.id : null,
    adopt: (queued) => {
      const runningActivities =
        new Map<ProviderActivityEvent["kind"], AgentActivity[]>();
      const activeConversation = providerSessionInvalidation
        ? {
            ...turnConversation,
            providerSessionId: null,
            continuationIdentity: null,
          }
        : turnConversation;
      return {
        queued,
        active: {
          turn: queued.turn,
          conversation: activeConversation,
          providerInput,
          attachmentIds: attachments.map(({ id }) => id),
          generatedAttachmentPaths: [...(request.generatedAttachmentPaths ?? [])],
          checkpointId: request.checkpointId ?? null,
          checkpointFailure: request.checkpointId
            ? null
            : request.checkpointFailure ?? null,
          ...(request.turnCheckpoint && !request.checkpointId
            ? { turnCheckpoint: true }
            : {}),
          rendererOwnerId: request.rendererOwnerId ?? null,
          structuredContext,
          gitBeforeCapture: null,
          runStartedAt: dependencies.clock().getTime(),
          workspaceRunCreated: false,
          providerRunStarted: false,
          providerInvoked: false,
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
            ? assembleFallback
            : null,
          lastUsage: null,
          assistantText: "",
          assistantPendingHighSurrogate: "",
          assistantSegmentText: "",
          assistantMessageId: null,
          latestAssistantMessageId: null,
          followUpBoundary: null,
          pendingFollowUpBoundary: null,
          reasoningText: "",
          reasoningPendingHighSurrogate: "",
          reasoningId: null,
          timeoutTimer: null,
          lifetimeTimer: null,
          runningActivities,
          providerActivitiesById: new Map<string, AgentActivity>(),
          providerActivityDetailChars: 0,
          providerCommandRuns: new Map<string, { id: string; label: string }>(),
          providerOutputActivityIds: new Set<string>(),
          pendingActivityUpdates: new Map<string, AgentActivity>(),
          activityFlushTimer: null,
          approvalIds: new Set<string>(),
          inputIds: new Set<string>(),
          onSettled: request.onSettled,
        },
      };
    },
  };
}
