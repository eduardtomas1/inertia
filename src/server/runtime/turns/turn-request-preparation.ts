import type { AgentActivity, Conversation, ProviderId, ProviderInfo } from "../../../shared/contracts";
import { providerInstanceId } from "../../orchestration-v2/provider-instance";
import {
  officiallyAllowsFastModeSwitchWithinSession,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
  staleProviderSessionDecision,
} from "../../../shared/continuation-policy";
import {
  modelSelectionHasVerifiedProbeCapability,
  modelSelectionSchema,
  providerIdForHarness,
  providerNativeBackendProfile,
  providerNativeHarnessId,
  providerNativeModelSelection,
  routeSupportsNativeFastModeIdentity,
  type ModelBackendProfile,
  type ModelSelection,
} from "../../../shared/model-routing";
import { NATIVE_ANTHROPIC_PROFILE_ID } from "../../../shared/claude-backend-profiles";
import { officialPresetEndpoint } from "../backends/backend-profile-presets";
import { importedFollowUpNote, importedResumeCwd, importedSession, sameCheckoutPath } from "../../cli-import/resume-cwd";
import type { RuntimeStore } from "../../database";
import { codexAutoCompactTokenLimit } from "../../../shared/compact-on-return";
import type { BeginAgentTurnInput } from "../../persistence/types";
import type { ProviderBacking } from "../../../shared/orchestration-backings";
import {
  providerBackgroundWork,
  type ProviderActivityEvent,
} from "../../provider/contracts";
import { PortableHistoryBudgetError, portableHistoryResponseItems } from "../../orchestration-v2/portable-history";
import { isItemCovered } from "../../orchestration-v2/backing-repository";
import { relocatedBackingId as relocatedProviderBackingId } from "../../orchestration-v2/backing-projector";
import { sessionCwdMobility } from "../../provider/session-cwd-mobility";
import { AuthoritativeRunStateEngine } from "../run-state-engine";
import {
  assembleTurnRequest,
  isProviderCommandText,
  type AssembleTurnRequestInput,
  type ConversationContextMaterialization,
  type RestoredChatHistory,
  type HiddenProviderInstruction,
} from "./request-context";
import {
  CheckoutMoveBackgroundWorkError,
  ContextHandoffBackgroundWorkError,
  appendedContextHandoff,
  exhaustedBackingSession,
  portableHistoryBudgetInputs,
  sameContextSelection,
  type OfferedRestoredHistory,
  type TurnContextProbes,
} from "./turn-context-handoff";
export { CheckoutMoveBackgroundWorkError, ContextHandoffBackgroundWorkError };
import { previousTurnBoundaryUsage } from "./turn-controller-support";
import { carriedMissedRunImages } from "./turn-missed-images";
import { harnessDeclaresCapability } from "../../provider/capability-manifest";
import { trackedGoalContextLine, trackedLocalGoal } from "./turn-goal-context";
import { PROVIDER_INFO } from "../../provider/catalog";
import { SLASH_COMMAND_PROVIDERS } from "../../provider/provider-slash-commands";
import { chatAttachmentKind } from "../../../shared/attachments";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  runtimeInterruptionInstruction,
  sharesInterruptionEndpoint,
} from "./turn-runtime-interruption-note";
import { routeUsesTrustedHostBridge } from "./turn-provider-host-tools";
import {
  instructionPack,
  resolveHiddenInstructionDelivery,
  sessionInstructionText,
  systemInstructionText,
  type PromptInstructionDeliveries,
} from "./turn-instruction-delivery";
import { watcherHarnessProfile } from "../../provider/watcher-harness-profile";
import { rejectGoalCustomAgentCall, resolveCustomAgentCall } from "./custom-agent-call";
import { FULL_HARNESS_CAPABILITY_OFFER } from "../harness-capabilities";
import {
  INERTIA_SECRETS_PACK_DIGEST,
  INERTIA_SECRETS_PACK_ID,
  SECRET_REQUEST_INSTRUCTION,
} from "../inertia-harness-capabilities";
import { codexThreadRegisteredPack } from "../../codex/app-server-thread-tools";
import { SECRET_REQUEST_FALLBACK_INSTRUCTION } from "../../../node/agent-secrets";
import type {
  ActiveTurn,
  QueuedTurn,
  QueueTurnRequest,
  ReadOnlyWatcherTurn,
  TurnControllerHooks,
  TurnProviderRuntime,
} from "./turn-controller-types";

const CUSTOM_BACKEND_RESTORED_HISTORY_BYTES = 48 * 1_024;

declare module "./turn-controller-types" {
  interface QueueTurnRequest {
    /**
     * Explicit per-item model selection carried by a queued message (Phase 5 Pkg 3).
     * Resolved for this turn without mutating the user's live composer selection on
     * `conversations`.
     */
    modelSelectionOverride?: ModelSelection | null;
  }
}

/**
 * Thrown when a queued item's explicit `modelSelectionOverride` targets a provider
 * or backend profile that is disabled or no longer available. The queue runtime
 * catches this error to block the item cleanly with reason `"provider-disabled"`
 * instead of failing a run.
 */
export class QueuedSelectionProviderUnavailableError extends RuntimeRequestError {
  readonly blockedReason = "provider-disabled" as const;

  constructor(
    message: string,
    readonly providerId?: ProviderId,
    options?: { cause?: unknown },
  ) {
    super(message, undefined, undefined);
    this.name = "QueuedSelectionProviderUnavailableError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function selectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  return left.harnessId === right.harnessId
    && left.backendProfileId === right.backendProfileId
    && left.backendConfigurationRevision === right.backendConfigurationRevision
    && left.modelId === right.modelId
    && (left.reasoningEffort ?? null) === (right.reasoningEffort ?? null)
    && Boolean(left.providerOptions.fastMode) === Boolean(right.providerOptions.fastMode);
}

type InstructionRoute = Parameters<typeof routeUsesTrustedHostBridge>[0];

export type PreparedActiveTurn = Omit<
  ActiveTurn,
  "assistantStream" | "reasoningStream"
>;

export interface PrepareTurnRequestDependencies {
  store: RuntimeStore;
  providers: TurnProviderRuntime & TurnContextProbes;
  hooks: TurnControllerHooks;
  instructionDeliveries?: PromptInstructionDeliveries;
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
  const queued = dependencies.store.beginOrchestratedAgentTurn(resolved.input, request.orchestrationRequest);
  try {
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

function reportsProviderCommand(
  dependencies: PrepareTurnRequestDependencies,
  conversationId: string,
  route: { providerId: ProviderId; harnessId: string },
  content: string,
): boolean {
  if (!isProviderCommandText(content) || route.harnessId !== providerNativeHarnessId(route.providerId)) return false;
  const name = content.trim().slice(1).split(/\s/u, 1)[0]!.toLowerCase();
  return dependencies.providers.reportedProviderCommands?.({
    providerId: route.providerId,
    cwd: dependencies.store.conversationPath(conversationId),
    conversationId,
  })?.some((command) => command.name.toLowerCase() === name) ?? false;
}

interface WatcherTurnPolicy {
  wakeId: string | null;
  readOnly?: ReadOnlyWatcherTurn;
}

const SECRET_REQUEST_FALLBACK_HIDDEN_INSTRUCTION: HiddenProviderInstruction = {
  label: "inertia-secrets-fallback",
  text: SECRET_REQUEST_FALLBACK_INSTRUCTION,
};

function secretAwareCapabilityInstructions(
  store: RuntimeStore,
  route: Pick<InstructionRoute, "providerId">,
  resumedSessionId: string | null,
  instructions: readonly HiddenProviderInstruction[],
): readonly HiddenProviderInstruction[] {
  if (
    route.providerId !== "codex"
    || resumedSessionId === null
    || !instructions.some(({ label }) => label === SECRET_REQUEST_INSTRUCTION.label)
    || codexThreadRegisteredPack(
      resumedSessionId,
      INERTIA_SECRETS_PACK_ID,
      INERTIA_SECRETS_PACK_DIGEST,
      store.codexThreadToolPacks,
    )
  ) return instructions;
  return [
    ...instructions.filter(({ label }) => label !== SECRET_REQUEST_INSTRUCTION.label),
    SECRET_REQUEST_FALLBACK_HIDDEN_INSTRUCTION,
  ];
}

function watcherTurnPolicy(
  store: RuntimeStore,
  conversation: Conversation,
  harnessId: string,
  request: QueueTurnRequest,
): WatcherTurnPolicy | undefined {
  const policy = store.watcherLinks.policyForConversation(conversation.id);
  if (!policy || policy.status === "detached") return undefined;
  try {
    store.watcherLinks.assertRunConfigurationAllowed(conversation.id, {
      interactionMode: conversation.interactionMode,
      accessMode: conversation.accessMode,
      harnessId,
    });
  } catch (error) {
    throw new RuntimeRequestError(error instanceof Error ? error.message : "This watcher stays read-only.");
  }
  if (request.goalStart !== undefined || request.watcherNote !== undefined) {
    throw new RuntimeRequestError("A watcher chat can't start goals or receive watcher notes.");
  }
  const wakeId = request.authorizedWatcherWakeId ?? null;
  if (!policy.readOnly) return { wakeId };
  return {
    wakeId,
    readOnly: {
      linkId: policy.linkId,
      wakeId,
      deniedApprovals: 0,
      editsGatedBeforeStart: watcherHarnessProfile(harnessId).editsGatedBeforeStart,
    },
  };
}

function providerCommandCarriesContext(
  request: QueueTurnRequest,
  attachments: readonly NonNullable<QueueTurnRequest["attachments"]>[number][],
): boolean {
  const context = request.context;
  return attachments.some((attachment) =>
    attachment.snapshot !== undefined || attachment.previewAnnotation !== undefined || chatAttachmentKind(attachment.mimeType) !== "image")
    || (request.documentContexts?.length ?? 0) > 0
    || [
      context?.fileReferences,
      context?.diffSelections,
      context?.terminalContexts,
      context?.previewContexts,
      context?.reviewNotes,
      context?.conversationContextPacketIds,
    ].some((references) => (references?.length ?? 0) > 0);
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

function routeHostBridgeAttested(
  providerInfo: readonly ProviderInfo[],
  route: InstructionRoute,
): boolean {
  const capabilityContract = providerInfo.find(({ id }) => id === route.providerId)?.capabilityContract;
  return capabilityContract !== undefined
    && capabilityContract.installationVerified
    && capabilityContract.hostToolBridgeAvailable
    && capabilityContract.harnessId === route.harnessId
    && routeUsesTrustedHostBridge(route);
}

/** A native session the turn replaces with a fresh one carrying the portable history; retired at adoption. */
interface ReplacedBacking {
  backing: ProviderBacking;
  reason: "context-exhausted" | "rejected-native-history";
}

function replaceExhaustedSession(
  dependencies: PrepareTurnRequestDependencies,
  request: QueueTurnRequest,
  backing: ProviderBacking,
  exhaustion: PortableHistoryBudgetError,
): ResolvedTurnRequest {
  let replacement: ResolvedTurnRequest;
  try {
    replacement = resolveTurnRequest(dependencies, request, { backing, reason: "context-exhausted" });
  } catch (error) {
    throw error instanceof PortableHistoryBudgetError ? exhaustion : error;
  }
  if (providerBackgroundWork(dependencies.providers, exhaustedBackingSession(backing)) === "pending") {
    throw new ContextHandoffBackgroundWorkError();
  }
  return replacement;
}

/**
 * T3 `rejected_native_history` (b99333dc7): Codex rejected the encrypted history of the native session this
 * turn would resume, on the latest run its provider accepted. The turn starts a fresh session with the full
 * portable history instead, and the rejected session's backing is retired. A fresh session would orphan
 * background work still running on the rejected one, so the turn is refused first while any is pending.
 */
function replaceRejectedHistorySession(
  dependencies: PrepareTurnRequestDependencies,
  request: QueueTurnRequest,
  backing: ProviderBacking,
): ResolvedTurnRequest {
  if (providerBackgroundWork(dependencies.providers, exhaustedBackingSession(backing)) === "pending") {
    throw new ContextHandoffBackgroundWorkError("rejected-native-history");
  }
  return resolveTurnRequest(dependencies, request, { backing, reason: "rejected-native-history" });
}

export function compactionSessionInstruction(
  dependencies: Pick<PrepareTurnRequestDependencies, "store" | "hooks">,
  conversation: Conversation,
  route: InstructionRoute,
): string | undefined {
  const watcher = dependencies.store.watcherLinks.policyForConversation(conversation.id);
  if (
    !routeHostBridgeAttested(dependencies.hooks.providerInfo(), route)
    || (watcher !== null && watcher.status !== "detached")
    || (route.providerId === "codex"
      && importedSession(dependencies.store, conversation.id, conversation.providerSessionId) !== null)
  ) return undefined;
  return sessionInstructionText(
    route.harnessId,
    instructionPack(
      conversation.id,
      secretAwareCapabilityInstructions(
        dependencies.store,
        route,
        conversation.providerSessionId,
        dependencies.hooks.capabilityOfferForTurn?.({ conversation }).instructions ?? [],
      ),
    ),
  );
}

export function codexCompactionLimitApplies(route: {
  providerId: string;
  harnessId: string;
  backendProfile: Pick<ModelBackendProfile, "id" | "protocol" | "source" | "endpointIdentity">;
}): boolean {
  return route.providerId === "codex"
    && route.harnessId === "codex-app-server"
    && (
      route.backendProfile.id === providerNativeBackendProfile("codex").id
      || officialPresetEndpoint(route.backendProfile)
    );
}

function codexContextWindow(
  store: Pick<RuntimeStore, "usageForConversation" | "agentTurn">,
  conversationId: string,
  selection: Pick<ModelSelection, "backendProfileId" | "modelId">,
): number | null {
  const usage = store.usageForConversation(conversationId);
  if (!usage?.turnId || usage.maxTokens === null) return null;
  let reported: ReturnType<RuntimeStore["agentTurn"]>;
  try {
    reported = store.agentTurn(usage.turnId);
  } catch {
    return null;
  }
  return reported.conversationId === conversationId
    && reported.providerId === "codex"
    && reported.modelSelection.backendProfileId === selection.backendProfileId
    && reported.modelSelection.modelId === selection.modelId
    ? usage.maxTokens
    : null;
}

export function claudeSpendLimitApplies(route: {
  providerId: string;
  harnessId: string;
  backendProfile: Pick<ModelBackendProfile, "id" | "protocol" | "source" | "endpointIdentity">;
}): boolean {
  return route.providerId === "claude"
    && route.harnessId === "claude-agent-sdk"
    && (
      route.backendProfile.id === NATIVE_ANTHROPIC_PROFILE_ID
      || officialPresetEndpoint(route.backendProfile)
    );
}

export function resolveTurnRequest(
  dependencies: PrepareTurnRequestDependencies,
  request: QueueTurnRequest,
  replacedBacking?: ReplacedBacking,
): ResolvedTurnRequest {
  const conversation = dependencies.store.conversation(request.conversationId);
  const attachments = [...(request.attachments ?? [])];
  const providerInfo = dependencies.hooks.providerInfo();
  const hasSelectionOverride = request.modelSelectionOverride !== undefined
    && request.modelSelectionOverride !== null;
  const effectiveSelection = hasSelectionOverride
    ? request.modelSelectionOverride!
    : conversation.modelSelection;
  const effectiveProviderId = providerIdForHarness(effectiveSelection.harnessId)
    ?? conversation.providerId;
  const selectedProvider = providerInfo.find(
    ({ id }) => id === effectiveProviderId,
  );
  const runId = dependencies.id();
  const turnId = dependencies.id();
  const requestedModelId = effectiveSelection.modelId;
  const selectedModel = requestedModelId !== "provider-default"
    ? selectedProvider?.models.find(({ id }) => id === requestedModelId)
    : selectedProvider?.models.find(({ isDefault }) => isDefault)
      ?? selectedProvider?.models[0];
  let parsedSelection: ModelSelection;
  let routeSelection: ModelSelection;
  let route: ReturnType<TurnProviderRuntime["resolveModelRoute"]>;
  try {
    parsedSelection = modelSelectionSchema.parse(effectiveSelection);
    routeSelection = dependencies.hooks.validateModelSelection?.(
      parsedSelection,
    ) ?? parsedSelection;
    route = dependencies.providers.resolveModelRoute(routeSelection);
  } catch (error) {
    if (hasSelectionOverride) {
      const detail = error instanceof Error && error.message.trim().length > 0
        ? error.message
        : `The queued message's provider or backend for ${PROVIDER_INFO[effectiveProviderId].name} is disabled or unavailable.`;
      throw new QueuedSelectionProviderUnavailableError(detail, effectiveProviderId, { cause: error });
    }
    throw error;
  }
  const modelSelection = requestedModelId === "provider-default"
    && selectedModel
    ? providerNativeModelSelection({
        providerId: route.providerId,
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
  if (!hasSelectionOverride) {
    dependencies.store.assertConversationProvider(conversation.id, route.providerId);
  }
  const exactProvider = providerInfo.find(({ id }) => id === route.providerId);
  if (hasSelectionOverride && providerInfo.length > 0 && (!exactProvider || exactProvider.canRun === false)) {
    throw new QueuedSelectionProviderUnavailableError(
      exactProvider?.statusMessage
        ?? `${PROVIDER_INFO[route.providerId].name} is disabled or unavailable for this queued message.`,
      route.providerId,
    );
  }
  const watcherTurn = watcherTurnPolicy(dependencies.store, conversation, route.harnessId, request);
  const readOnlyWatcher = watcherTurn?.readOnly;
  const calledAgent = request.context?.calledAgent;
  if (calledAgent && request.goalStart !== undefined) rejectGoalCustomAgentCall();
  const customAgentCall = calledAgent
    ? resolveCustomAgentCall({ calledAgent, store: dependencies.store, providerId: route.providerId })
    : null;
  const providerCommand = request.goalStart === undefined
    && watcherTurn === undefined
    && customAgentCall === null
    && request.watcherNote === undefined
    && request.systemInstructions === undefined
    && (request.internalInstructions?.length ?? 0) === 0
    && SLASH_COMMAND_PROVIDERS.includes(route.providerId)
    && reportsProviderCommand(dependencies, conversation.id, route, request.content);
  const providerName = PROVIDER_INFO[route.providerId].name;
  if (providerCommand && providerCommandCarriesContext(request, attachments)) {
    throw new RuntimeRequestError(
      `${providerName} runs ${request.content.trim().split(/\s/u, 1)[0]} on its own. Remove the attached files and context, then send it again.`,
    );
  }
  const hostToolBridgeAttested = routeHostBridgeAttested(providerInfo, route);
  // Read once: the prompt's instructions and the tools attached at provider
  // start must describe the same offer even if project settings change.
  const capabilityOffer = hostToolBridgeAttested
    ? dependencies.hooks.capabilityOfferForTurn?.({ conversation })
      ?? { instructions: [], offer: FULL_HARNESS_CAPABILITY_OFFER }
    : undefined;
  const capabilityInstructions = watcherTurn
    ? []
    : capabilityOffer?.instructions ?? [SECRET_REQUEST_FALLBACK_HIDDEN_INSTRUCTION];
  const roleInstructions = request.systemInstructions
    ?? (watcherTurn?.wakeId === null
      ? dependencies.hooks.watcherInstructionsForTurn?.({ conversation, hostTools: hostToolBridgeAttested }) ?? []
      : []);
  const systemInstruction = watcherHarnessProfile(route.harnessId).systemInstruction
    ? systemInstructionText(roleInstructions)
    : undefined;
  const watcherInstructions = systemInstruction === undefined ? roleInstructions : [];

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
  // Images of earlier runs on this provider instance that never reached it ride on this prompt, provider-only (T3).
  // A goal start withholds its prompt, and a model or harness without image input takes none (Cursor SDK and
  // Antigravity refuse any image); none of these refuses the send.
  const missedImages = carriedMissedRunImages({
    providerId: route.providerId,
    candidates: request.goalStart === undefined && supportsImages && harnessDeclaresCapability(route.harnessId, "images")
      && dependencies.hooks.missedRunImageCheck
      ? dependencies.store.orchestration.missedRunImages({ threadId: conversation.id,
        providerInstanceId: providerInstanceId(route.providerId, route.continuationIdentity) })
      : [],
    ownAttachments: attachments,
    ownImagePaths: request.imagePaths,
    openCheck: dependencies.hooks.missedRunImageCheck,
  });
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
  const conversationMatchesRouteProvider = conversation.providerId === route.providerId;
  const conversationSessionForRoute = conversationMatchesRouteProvider
    ? conversation.providerSessionId
    : null;
  const latestTurnOwnsProviderSession = latestTurn !== null
    && conversationSessionForRoute !== null
    && latestTurn.providerSessionAfter === conversationSessionForRoute;
  const checkout = dependencies.store.conversationPath(conversation.id);
  const backingLookup = { threadId: conversation.id, providerId: route.providerId, identity: route.continuationIdentity };
  const localBacking = dependencies.store.orchestration.backings.find({ ...backingLookup, workspaceKey: checkout });
  // The chat's current native conversation for this provider instance may live in a checkout it used
  // before. A harness that resumes across checkouts continues it here (T3 restart_and_resume); any other
  // harness keeps a live session of this checkout, or starts fresh with the portable history.
  const mobility = sessionCwdMobility(route.harnessId);
  const currentBacking = dependencies.store.orchestration.backings.current(backingLookup);
  const movedBacking = currentBacking && currentBacking.workspaceKey !== checkout
    && (mobility === "resume" || !localBacking || localBacking.status === "retired") ? currentBacking : null;
  const candidateBacking = movedBacking ?? localBacking;
  const usable = (backing: ProviderBacking | null) => backing?.status === "ready" && backing.coverageComplete
    && backing.id !== replacedBacking?.backing.id ? backing : null;
  const relocation = movedBacking && mobility === "resume" && usable(movedBacking)
    && !dependencies.store.orchestration.history.continuationFor({ threadId: conversation.id,
      providerInstanceId: movedBacking.providerInstanceId, workspaceKey: movedBacking.workspaceKey,
      nativeSessionId: movedBacking.nativeSessionId }) ? movedBacking : null;
  const reusableBacking = movedBacking ? relocation : usable(localBacking);
  const relocatedBackingId = relocation ? relocatedProviderBackingId(relocation, checkout) : null;
  // A session without a backing (imported, recorded before backings, or a native fork before its first turn)
  // is never resumed by a harness that cannot move when it is known to belong to another checkout. A session
  // nothing records keeps resuming, as before backings existed.
  const unbackedSessionRanHere = (sessionId: string): boolean => {
    const known = importedSession(dependencies.store, conversation.id, sessionId)?.cwd
      ?? dependencies.store.orchestration.backings.sessionWorkspaceKey(conversation.id, sessionId);
    return known === null || sameCheckoutPath(known, checkout);
  };
  const resumeSessionId = reusableBacking?.nativeSessionId ?? conversationSessionForRoute;
  const previousContinuationIdentity = reusableBacking?.continuationIdentity ?? (candidateBacking ? null : latestTurn
    ? latestTurnOwnsProviderSession
      ? latestTurn.continuationIdentity
      : null
    : conversationMatchesRouteProvider ? conversation.continuationIdentity ?? null : null);
  const previousContinuationModelId = previousContinuationIdentity
    ? routeSelection.modelId === "provider-default"
      ? "provider-default"
      : reusableBacking ? reusableBacking.selection.modelId : latestTurn
        ? latestTurn.modelSelection.modelId
        : routeSelection.modelId
    : null;
  const resolvedContinuation = resolveContinuationDecision({
    ...(reusableBacking ? { previousProviderId: route.providerId } : latestTurn ? { previousProviderId: latestTurn.providerId } : {}),
    previousIdentity: previousContinuationIdentity,
    nextIdentity: route.continuationIdentity,
    previousModelId: previousContinuationModelId,
    nextModelId: routeSelection.modelId,
    hasProviderSession: resumeSessionId !== null && (candidateBacking
      ? reusableBacking !== null
      // A session whose backing was retired (uncertain delivery, a retired relocation) stays retired anywhere.
      : !dependencies.store.orchestration.backings.sessionRetired({ ...backingLookup, nativeSessionId: resumeSessionId })
        && (mobility === "resume" || unbackedSessionRanHere(resumeSessionId))),
    hasTurns: latestTurn !== null,
    allowsModelSwitchWithinSession:
      officiallyAllowsModelSwitchWithinSession(route.compatibility),
    allowsPerformanceModeSwitchWithinSession:
      officiallyAllowsFastModeSwitchWithinSession(route.compatibility)
      && supportedFastMode !== null,
  });
  const continuation = resolvedContinuation.action === "resume-session"
    && latestTurn?.status === "failed"
    && importedSession(dependencies.store, conversation.id, conversationSessionForRoute) === null
    && dependencies.store.turnLedgerRepository.savedSessionKeepsFailing(
      conversation.id,
      resumeSessionId!,
    )
    ? staleProviderSessionDecision()
    : resolvedContinuation;
  // Only a turn that would resume the backing's native session (T3 checks at the native resume). A goal start
  // withholds its prompt and a fresh session gets no history without one, so it resumes, as with exhaustion.
  if (route.providerId === "codex" && continuation.action === "resume-session" && reusableBacking
    && replacedBacking === undefined && request.goalStart === undefined
    && resumeSessionId === reusableBacking.nativeSessionId
    && dependencies.store.orchestration.rejectedNativeHistorySession(conversation.id, reusableBacking.providerInstanceId)
      === reusableBacking.nativeSessionId) {
    return replaceRejectedHistorySession(dependencies, request, reusableBacking);
  }
  const resumesImportedCodex = continuation.action === "resume-session" && route.providerId === "codex"
    && importedSession(dependencies.store, conversation.id, conversationSessionForRoute) !== null;
  const canResume = continuation.action === "resume-session";
  const sessionOrigin = canResume
    ? dependencies.store.orchestration.backings.sessionOriginWorkspaceKey(conversation.id, resumeSessionId!) : null;
  const nativeContinuation = canResume ? dependencies.store.orchestration.history.continuationFor({ threadId: conversation.id,
    providerInstanceId: providerInstanceId(route.providerId, route.continuationIdentity),
    workspaceKey: dependencies.store.conversationPath(conversation.id), nativeSessionId: resumeSessionId! }) : null;
  const effectiveCapabilityInstructions = capabilityOffer && !watcherTurn
    ? secretAwareCapabilityInstructions(
        dependencies.store,
        route,
        canResume ? resumeSessionId : null,
        capabilityInstructions,
      )
    : capabilityInstructions;
  const instructionDelivery = resolveHiddenInstructionDelivery({
    store: dependencies.store,
    deliveries: dependencies.instructionDeliveries,
    conversation,
    harnessId: route.harnessId,
    pack: resumesImportedCodex
      ? []
      : hostToolBridgeAttested
        ? instructionPack(conversation.id, effectiveCapabilityInstructions)
        : effectiveCapabilityInstructions,
    resumedSessionId: canResume ? resumeSessionId : null,
    latestTurn,
    promptWithheld: request.goalStart !== undefined || providerCommand,
  });
  const contextPacketIds = request.context?.conversationContextPacketIds ?? [];
  const interruptedTurnId = dependencies.store.turnLedgerRepository
    .runtimeInterruptionSource(conversation.id);
  if (providerCommand && interruptedTurnId !== null) {
    throw new RuntimeRequestError(
      `Send a message first so ${providerName} learns that its previous turn was interrupted.`,
    );
  }
  const requestedAt = dependencies.now();
  let conversationContexts: ConversationContextMaterialization | undefined;
  const turnInstructions = [
    ...watcherInstructions,
    ...(interruptedTurnId === null ? [] : [runtimeInterruptionInstruction(
      sharesInterruptionEndpoint(
        dependencies.store.agentTurn(interruptedTurnId).continuationIdentity,
        route.continuationIdentity,
      )
        ? dependencies.store.turnLedgerRepository.runtimeInterruption(interruptedTurnId)
        : null,
    )]),
    ...(request.internalInstructions ?? []),
    ...(customAgentCall ? [customAgentCall.instructionBlock] : []),
  ];
  // Codex-native goals reach the provider through its own thread-goal API;
  // only an Inertia-local goal is described here, as visible context.
  const localGoal = trackedLocalGoal(dependencies.store.agentGoals(conversation.id));
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
    ...(instructionDelivery.buildModeDue ? { interactionMode: conversation.interactionMode } : {}),
    attachments,
    imagePaths: missedImages.imagePaths ?? request.imagePaths,
    documentContexts: request.documentContexts,
    context: request.context,
    internalInstructions: [...instructionDelivery.promptPack, ...turnInstructions],
    ...(instructionDelivery.sessionInstructionDigest === undefined
      ? {}
      : { sessionInstructionDigest: instructionDelivery.sessionInstructionDigest }),
    ...(request.goalStart === undefined ? {} : { promptWithheld: true as const }),
    ...(providerCommand ? { providerCommand: true as const } : {}),
    ...(localGoal && !providerCommand ? { trackedGoalLine: trackedGoalContextLine(localGoal) } : {}),
  } satisfies AssembleTurnRequestInput;
  const ownChatPacketId = dependencies.store.contextPackets
    .ownConversationPacketId(conversation.id, contextPacketIds);
  const unattributedHistoryOnRoute = () => {
    const { backendProfileId, endpointIdentity } = route.continuationIdentity;
    const shell = conversationMatchesRouteProvider ? conversation.continuationIdentity : null;
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
  // A turn whose context handoff never reached its provider did not move the
  // conversation onto that route; the switch it attempted is still due.
  const routeTurnId = latestTurn ? dependencies.store.orchestration.backings.deliveredRouteTurnId(conversation.id) : null;
  const routeTurn = routeTurnId === null ? null : routeTurnId === latestTurn?.id ? latestTurn
    : dependencies.store.agentTurn(routeTurnId);
  // No turn ever reached a provider: whatever switch those turns attempted is still due.
  const providerHandoff = latestTurn !== null
    && (routeTurn === null || routeTurn.providerId !== route.providerId);
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
  const referencedCapacity = (capacityBytes: number) => usesNativeCatalog
    ? capacityBytes
    : Math.min(capacityBytes, CUSTOM_BACKEND_RESTORED_HISTORY_BYTES);
  const referencedHistory = (capacityBytes: number) => {
    const delivery = conversationContexts?.deliveries
      .find(({ packetId }) => packetId === ownChatPacketId);
    return dependencies.store.transcriptRepository.referencedContinuationHistory(
      conversation.id,
      referencedCapacity(capacityBytes),
      restoredHistoryRoute(),
      {
        messageCount: delivery?.messageCount ?? 0,
        omittedMessageCount: delivery?.omittedMessageCount ?? 0,
      },
    );
  };
  let offeredHistory: OfferedRestoredHistory | null = null;
  const offer = (history: RestoredChatHistory | null, targetBackingId: string | null) => {
    offeredHistory = history ? { history, targetBackingId } : null;
    return history;
  };
  const prepareHistory = (capacityBytes: number, currentPromptBytes: number,
    options: { excludedMessageId?: string; target: ProviderBacking | null; skipEmpty?: boolean }) => {
    const { target } = options;
    // An adopted unread follow-up is already persisted, but it is this turn's prompt, never its history.
    const excludedMessageId = options.excludedMessageId ?? request.adoptedFollowUp?.messageId;
    const usage = target ? previousTurnBoundaryUsage(dependencies.store.agentTurn(target.lastTurnId), target.nativeSessionId) : null;
    const history = dependencies.store.orchestration.portableHistory({
      threadId: conversation.id, capacityBytes, currentPromptBytes,
      ...portableHistoryBudgetInputs({
        attachments, imageCount: (request.imagePaths?.length ?? 0) + missedImages.attachmentIds.length,
        configuredWindow: routeSelection.contextWindowOverride,
        limits: dependencies.providers.modelContextLimits?.({ providerId: route.providerId, harnessId: route.harnessId,
          selection: routeSelection, cwd: dependencies.store.conversationPath(conversation.id) }) ?? null,
        target: target ? { usage, sameSelection: sameContextSelection(target.selection, routeSelection) } : null,
      }),
      ...(excludedMessageId === undefined ? {} : { excludedMessageId }),
      ...(target ? { coverage: target } : {}), route: restoredHistoryRoute(),
      hostToolBridgeAttested,
    });
    if (!history || (options.skipEmpty && history.messageCount === 0 && history.omittedMessageCount === 0)) {
      return offer(null, null);
    }
    return offer({ ...history, itemIds: history.selection.items.map(({ id }) => id),
      omittedItemIds: history.selection.omittedItemIds,
      injectionItems: portableHistoryResponseItems(history.selection.items, history.selection.context) },
    target ? target.id === relocation?.id ? relocatedBackingId : target.id : null);
  };
  const assembleOnFreshSession = (excludedMessageId?: string) => {
    offeredHistory = null;
    const assembled = assembleTurnRequest({
    ...assemblyInput,
    interactionMode: conversation.interactionMode,
    internalInstructions: [...instructionDelivery.freshSessionPromptPack, ...turnInstructions],
    restoredHistory: ownChatPacketId === null
      ? (capacityBytes: number, currentPromptBytes: number) => prepareHistory(capacityBytes, currentPromptBytes,
        { ...(excludedMessageId === undefined ? {} : { excludedMessageId }), target: null })
      : (capacityBytes: number) => offer(referencedHistory(capacityBytes), null),
    });
    const contextHandoff = appendedContextHandoff(assembled, offeredHistory);
    return { ...assembled, ...(contextHandoff ? { contextHandoff } : {}) };
  };
  const importNote = latestTurn?.origin === "cli-import"
    ? importedFollowUpNote(dependencies.store.cliConversationImport(conversation.id), canResume && importedSession(dependencies.store, conversation.id, conversation.providerSessionId) !== null)
    : null;
  const startsFreshInEstablishedChat = !canResume
    && (continuation.reasonCode !== "first-turn"
      || (dependencies.store.orchestration.forks.get(conversation.id)?.inheritedItems ?? 0) > 0)
    && request.goalStart === undefined;
  const deltaTarget = canResume && reusableBacking && request.goalStart === undefined ? reusableBacking : null;
  const deferredDeltaOnly = deltaTarget !== null && latestTurn?.id === deltaTarget.lastTurnId;
  // The session's last turn may not have reached it: a withheld prompt (goal start), or a prompt whose
  // turn never started after its history was injected (its message is then not covered).
  const lastTurnForDelta = deltaTarget && deferredDeltaOnly ? dependencies.store.agentTurn(deltaTarget.lastTurnId) : null;
  const lastTurnRunOrdinal = lastTurnForDelta
    ? ((dependencies.store.orchestration.events.projection("run", lastTurnForDelta.runId)?.value as { ordinal?: number } | undefined)?.ordinal ?? null)
    : null;
  const pendingDelta = deltaTarget !== null
    && (!deferredDeltaOnly || dependencies.store.turnLedgerRepository.promptWithheld(deltaTarget.lastTurnId)
      || (lastTurnForDelta !== null && !isItemCovered(deltaTarget, lastTurnForDelta.userMessageId, lastTurnRunOrdinal)));
  // A provider command is sent on its own. Turns its session missed on another route must reach it first; a delta
  // deferred from the session's own last turn (a withheld prompt or instruction pack) waits for the next message.
  if (providerCommand && pendingDelta && !deferredDeltaOnly) {
    throw new RuntimeRequestError(`Send a message first so ${providerName} receives this chat's earlier messages.`);
  }
  const deliversDelta = pendingDelta && !providerCommand;
  if (providerCommand && startsFreshInEstablishedChat) {
    throw new RuntimeRequestError(
      `Send a message first so ${providerName} receives this chat's earlier messages.`,
    );
  }
  const carriedConversationContexts = startsFreshInEstablishedChat
    ? []
    : dependencies.store.contextPackets
      .unreachedReferences(conversation.id)
      .flatMap((reference) => reference.sentBlocks() ?? []);
  if (providerCommand && carriedConversationContexts.length > 0) {
    throw new RuntimeRequestError(
      `Send a message first so ${providerName} receives the chats you referenced.`,
    );
  }
  const assembleOnResumedSession = () => {
    offeredHistory = null;
    const assembled = assembleTurnRequest({
      ...assemblyInput,
      ...(deliversDelta
        ? { restoredHistory: (capacity: number, promptBytes: number) => prepareHistory(capacity, promptBytes,
          { target: deltaTarget, skipEmpty: deferredDeltaOnly }) } : {}),
      carriedConversationContexts,
    });
    const contextHandoff = appendedContextHandoff(assembled, offeredHistory);
    return { ...assembled, ...(contextHandoff ? { contextHandoff } : {}) };
  };
  // Never resume a native session that another live process may still be writing.
  if (canResume && relocation
    && providerBackgroundWork(dependencies.providers, exhaustedBackingSession(relocation)) === "pending") {
    throw new CheckoutMoveBackgroundWorkError();
  }
  let assembled: ReturnType<typeof assembleOnFreshSession>;
  try {
    assembled = startsFreshInEstablishedChat ? assembleOnFreshSession() : assembleOnResumedSession();
  } catch (error) {
    if (error instanceof PortableHistoryBudgetError && deliversDelta && !startsFreshInEstablishedChat
      && replacedBacking === undefined) {
      return replaceExhaustedSession(dependencies, request, deltaTarget!, error);
    }
    throw error;
  }
  const { contextHandoff } = assembled;
  // The route's sessions this fresh start replaces (T3 d32df2d34): a fresh session reported under one of them is
  // that session with the restored history added, so the turn fails instead of adopting it.
  const replacedSessionIds = canResume ? [] : [...new Set([
    replacedBacking?.backing.nativeSessionId,
    movedBacking?.nativeSessionId,
    localBacking?.status === "retired" ? localBacking.nativeSessionId : undefined,
    continuation.reasonCode === "stale-provider-session" ? resumeSessionId : undefined,
  ].filter((sessionId): sessionId is string => typeof sessionId === "string"))];
  const providerSessionInvalidation = !canResume
    && conversationSessionForRoute
    && (!hasSelectionOverride || selectionsMatch(conversation.modelSelection, routeSelection))
    ? { expectedSessionId: conversationSessionForRoute }
    : undefined;
  const goalContinuationExpected = request.goalStart !== undefined
    || (canResume && dependencies.store.agentGoals(conversation.id).some((goal) =>
      goal.source === "codex-native"
      && goal.providerSessionId === resumeSessionId
      && goal.status === "active"));
  const maxBudgetUsd = claudeSpendLimitApplies(route)
    ? dependencies.store.project(conversation.projectId).preferences
      ?.claudeMaxBudgetUsd ?? null
    : null;
  const autoCompactWindow = claudeSpendLimitApplies(route)
    ? dependencies.store.settings().claudeAutoCompactWindow
    : null;
  const autoCompactTokenLimit = codexCompactionLimitApplies(route)
    ? codexAutoCompactTokenLimit(
      dependencies.store.settings().codexAutoCompactTokenLimit,
      codexContextWindow(dependencies.store, conversation.id, modelSelection),
    )
    : null;
  const providerCwd = canResume
    ? importedResumeCwd(dependencies.store, conversation.id, resumeSessionId, dependencies.store.conversationPath(conversation.id))
    : dependencies.store.conversationPath(conversation.id);
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
    cwd: providerCwd,
    prompt: assembled.executionPrompt,
    model: routeSelection.modelId === "provider-default"
      ? undefined
      : routeSelection.modelId,
    reasoningEffort: routeSelection.reasoningEffort || undefined,
    interactionMode: conversation.interactionMode,
    access: conversation.accessMode,
    sessionId: canResume ? resumeSessionId! : undefined,
    ...(sessionOrigin !== null && sessionOrigin !== providerCwd ? { sessionOriginCwd: sessionOrigin } : {}),
    ...(nativeContinuation ? { nativeContinuation: nativeContinuation.continuation } : {}),
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
      attachmentIds: [...missedImages.attachmentIds, ...attachments.map(({ id }) => id)],
    }) ?? [],
    skills: request.skills,
    ...(customAgentCall ? customAgentCall.providerInput : {}),
    ...(request.goalStart ? { goalStart: request.goalStart } : {}),
    ...(goalContinuationExpected ? { goalContinuationExpected: true } : {}),
    ...(maxBudgetUsd !== null ? { maxBudgetUsd } : {}),
    ...(autoCompactWindow !== null ? { autoCompactWindow } : {}),
    ...(autoCompactTokenLimit !== null ? { autoCompactTokenLimit } : {}),
    ...(readOnlyWatcher ? { readOnlyProfile: "watcher" as const } : {}),
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(instructionDelivery.sessionInstruction !== undefined
      ? { sessionInstruction: instructionDelivery.sessionInstruction }
      : {}),
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
    ...(request.adoptedFollowUp ? { adoptedFollowUp: request.adoptedFollowUp } : {}),
    limitResetPlanId: request.limitResetPlanId,
    restartContinuationPlanId: request.restartContinuationPlanId,
    id: turnId,
    conversationId: conversation.id,
    runId,
    content: assembled.visibleContent,
    attachments,
    activateConversation: request.activateConversation,
    privateConnectDeviceId: request.privateConnectDeviceId,
    ...(request.watcherNote ? { watcherNote: request.watcherNote } : {}),
    ...(request.delegatedCompletion ? { delegatedCompletion: request.delegatedCompletion } : {}),
    ...(customAgentCall ? { customAgentCall: customAgentCall.attribution } : {}),
    ...(request.duoComparison && request.duoComparison.launchId === request.authorizedDuoComparisonLaunchId
      ? { duoComparison: request.duoComparison }
      : {}),
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
    ...(contextHandoff ? { contextHandoff } : {}),
    ...(canResume && relocation ? { backingRelocation: { fromBackingId: relocation.id } } : {}),
    preparedWorkspaceKey: checkout,
    ...(nativeContinuation ? { nativeContinuation } : {}),
    harnessId,
    backendProfileId: modelSelection.backendProfileId,
    model: modelSelection.modelId,
    modelAlias: modelSelection.alias,
    reasoningEffort: modelSelection.reasoningEffort ?? "",
    interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode,
    providerSessionBefore: canResume ? resumeSessionId : null,
    ...(providerSessionInvalidation ? { providerSessionInvalidation } : {}),
    requestedAt,
    usageAtStart: canResume
      ? previousTurnBoundaryUsage(reusableBacking ? dependencies.store.agentTurn(reusableBacking.lastTurnId) : latestTurn, resumeSessionId!)
      : null,
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: "authoritative",
  };
  return {
    input,
    importNote,
    handoffFromTurnId: latestTurn !== null && latestTurn.providerId !== route.providerId ? latestTurn.id : null,
    adopt: (queued) => {
      const replaced = replacedBacking ? dependencies.store.orchestration.backings.get(replacedBacking.backing.id) : null;
      if (replaced) dependencies.store.orchestration.backings.invalidate(replaced, replacedBacking!.reason);
      instructionDelivery.recordPromptPack(queued.turn.id);
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
          ...(capabilityOffer ? { capabilityOffer: capabilityOffer.offer } : {}),
          attachmentIds: attachments.map(({ id }) => id),
          generatedAttachmentPaths: [...(request.generatedAttachmentPaths ?? [])],
          checkpointId: readOnlyWatcher ? null : request.checkpointId ?? null,
          checkpointFailure: request.checkpointId || readOnlyWatcher
            ? null
            : request.checkpointFailure ?? null,
          ...(request.turnCheckpoint && !request.checkpointId && !readOnlyWatcher
            ? { turnCheckpoint: true }
            : {}),
          ...(readOnlyWatcher ? { readOnlyWatcher } : {}),
          ...(customAgentCall ? { customAgentCall: customAgentCall.attribution } : {}),
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
          sessionAfter: canResume ? resumeSessionId : null,
          nativeHistory: contextHandoff ? assembled.nativeHistory ?? null : null,
          freshSessionRequest: canResume && request.goalStart === undefined && !providerCommand
            ? assembleOnFreshSession
            : null,
          ...(replacedSessionIds.length > 0 ? { replacedSessionIds } : {}),
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
