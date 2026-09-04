import type { AgentActivity, ChatMessage } from "../../../shared/contracts";
import {
  officiallyAllowsFastModeSwitchWithinSession,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
} from "../../../shared/continuation-policy";
import {
  modelSelectionSchema,
  providerNativeBackendProfile,
  providerNativeModelSelection,
  routeSupportsNativeFastModeIdentity,
} from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import type { BeginAgentTurnInput } from "../../persistence/types";
import type {
  ProviderActivityEvent,
  ProviderRunInput,
} from "../../provider/contracts";
import { AuthoritativeRunStateEngine } from "../run-state-engine";
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

const MAX_RECONSTRUCTED_HISTORY_MESSAGES = 64;
const MAX_RECONSTRUCTED_MESSAGE_CHARS = 24 * 1024;
const MAX_RECONSTRUCTED_HISTORY_CHARS = 96 * 1024;

/**
 * Gemini CLI v0.58 cannot safely load an ACP session: its floating history
 * replay has no EOF and its recorder can overwrite the session being loaded.
 * Preserve useful conversational continuity with a bounded copy of the
 * visible, turn-owned transcript instead. This deliberately excludes system
 * rows, reasoning, activities, tool payloads, and unassociated current input.
 */
export function reconstructedVisibleHistory(
  messages: readonly ChatMessage[],
): ProviderRunInput["reconstructedHistory"] {
  const eligible = messages.filter((message) =>
    message.turnId !== null
    && (message.role === "user" || message.role === "assistant")
    && message.content.length > 0);
  const retained = eligible.slice(-MAX_RECONSTRUCTED_HISTORY_MESSAGES);
  let truncated = retained.length !== eligible.length;
  let remaining = MAX_RECONSTRUCTED_HISTORY_CHARS;
  const bounded: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (let index = retained.length - 1; index >= 0; index -= 1) {
    const message = retained[index]!;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const maximum = Math.min(MAX_RECONSTRUCTED_MESSAGE_CHARS, remaining);
    const content = boundedHistoryText(message.content, maximum);
    if (content.length !== message.content.length) truncated = true;
    remaining -= content.length;
    bounded.unshift({ role: message.role as "user" | "assistant", content });
  }

  if (bounded.length === 0) return undefined;
  return { source: "visible-transcript", truncated, messages: bounded };
}

function boundedHistoryText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum < 64) return value.slice(0, maximum);
  const marker = "\n[… historical message truncated by Inertia …]\n";
  const available = maximum - marker.length;
  const head = Math.ceil(available / 2);
  return value.slice(0, head) + marker + value.slice(-(available - head));
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
  const capabilityInstructions = dependencies.hooks
    .harnessInstructionsForTurn?.({ conversation }) ?? [];
  const assembled = assembleTurnRequest({
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
  // Gemini learns the active default only from the new ACP session. Cached
  // metadata can be stale before that session exists, so persist the honest
  // provider-default request instead of attributing the immutable turn and
  // usage record to a model the provider may not actually use.
  const canResolveDefaultBeforeRun = conversation.providerId !== "gemini";
  const modelSelection = requestedModelId === "provider-default"
    && selectedModel
    && canResolveDefaultBeforeRun
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
  const exactProvider = providerInfo.find(({ id }) => id === route.providerId);
  const exactModel = routeSelection.modelId === "provider-default"
    ? exactProvider?.models.find(({ isDefault }) => isDefault)
      ?? exactProvider?.models[0]
    : exactProvider?.models.find(({ id }) => id === routeSelection.modelId);
  const usesNativeCatalog = route.backendProfile.source === "built-in"
    && route.backendProfile.id === providerNativeBackendProfile(route.providerId).id;
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
  // Gemini ACP session/load is unsafe in v0.58. Gemini continuations use the
  // bounded visible transcript below and always create a fresh ACP session.
  const canResume = continuation.action === "resume-session"
    && route.providerId !== "gemini";
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
    ...(route.providerId === "gemini"
      ? {
          reconstructedHistory: reconstructedVisibleHistory(
            dependencies.store.conversationDetail(conversation.id)?.messages ?? [],
          ),
        }
      : {}),
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
          runState: new AuthoritativeRunStateEngine({
            conversationId: conversation.id,
            runId: queued.turn.runId,
            turnId: queued.turn.id,
            providerId: route.providerId,
          }),
          deferredSettlement: null,
          providerStopStarted: false,
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
