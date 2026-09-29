import { providerIdForHarness } from "../../../shared/model-routing";
import type {
  ContinuationIdentity,
  Conversation,
  HarnessBackendCompatibility,
  ModelSelection,
  ProviderId,
} from "@shared/contracts";
import type { PendingModelRoute } from "../components/composer/types";
import type { ReplacementChatRequest } from "../lib/newConversation";
import {
  conversationContinuationRefusal,
  conversationHasHistory,
  officiallyAllowsFastModeSwitchWithinSession,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
  type ContinuationChangeKind,
  type ContinuationReasonCode,
} from "../../../shared/continuation-policy";

type TransitionCompatibility = Pick<
  HarnessBackendCompatibility,
  "state" | "allowsModelSwitchWithinSession"
>;

export interface ModelRouteTransitionContext {
  /** The selected project is carried across a required new-conversation path. */
  projectId: string;
  providerId: ProviderId;
  selection: ModelSelection;
  continuationIdentity: ContinuationIdentity | null;
  latestTurn: {
    selection: ModelSelection;
    continuationIdentity: ContinuationIdentity;
  } | null;
  /** Only session presence is accepted; session identifiers never enter this policy. */
  hasProviderSession: boolean;
  hasHistory: boolean;
  mixedProviderHistory: boolean;
}

export interface ModelRouteTransitionCandidate {
  selection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  compatibility: TransitionCompatibility;
  /** Current exact-model evidence that both Fast and Standard are forceable. */
  supportsNativeFastModeControl?: boolean;
}

interface ModelRouteTransitionBase {
  projectId: string;
  selection: ModelSelection;
  changeKind: ContinuationChangeKind;
  reasonCode: ContinuationReasonCode;
  reason: string;
}

export type ModelRouteTransition =
  | (ModelRouteTransitionBase & {
      kind: "update-current-conversation";
      providerSessionDisposition: "retain-current-conversation";
      continuationAction: "start-session" | "resume-session";
    })
  | (ModelRouteTransitionBase & {
      kind: "create-new-conversation";
      providerSessionDisposition: "start-unbound";
      continuationAction: "new-conversation-required";
    });

export function modelRouteTransitionContext(
  conversation: Conversation,
  latestTurn: { modelSelection: ModelSelection; continuationIdentity: ContinuationIdentity } | null,
): ModelRouteTransitionContext {
  return {
    projectId: conversation.projectId,
    providerId: conversation.providerId,
    selection: conversation.modelSelection,
    continuationIdentity: conversation.continuationIdentity,
    latestTurn: latestTurn
      ? { selection: latestTurn.modelSelection, continuationIdentity: latestTurn.continuationIdentity }
      : null,
    hasProviderSession: Boolean(conversation.providerSessionId),
    hasHistory: conversationHasHistory(conversation),
    mixedProviderHistory: conversationContinuationRefusal(conversation) !== null,
  };
}

export function pendingModelRoute(
  conversation: Conversation,
  latestTurn: { id: string; modelSelection: ModelSelection; continuationIdentity: ContinuationIdentity } | null,
  { selection, configuration }: ReplacementChatRequest,
  label: string,
  reason: string,
): PendingModelRoute {
  return {
    selection,
    configuration,
    label,
    reason,
    sourceConversationId: conversation.id,
    sourceProjectId: conversation.projectId,
    sourceSelectionKey: JSON.stringify(conversation.modelSelection),
    sourceConfigurationKey: `${conversation.accessMode}:${conversation.interactionMode}`,
    sourceContinuationKey: JSON.stringify(conversation.continuationIdentity),
    sourceLatestTurnId: latestTurn?.id ?? null,
    sourceLatestTurnKey: JSON.stringify(latestTurn
      ? {
          id: latestTurn.id,
          modelSelection: latestTurn.modelSelection,
          continuationIdentity: latestTurn.continuationIdentity,
        }
      : null),
    destinationRevision: selection.backendConfigurationRevision,
  };
}

/**
 * Plans a chooser route change without accepting or returning a provider
 * session identifier. The shared continuation policy remains authoritative.
 */
export function resolveModelRouteTransition(
  context: ModelRouteTransitionContext,
  candidate: ModelRouteTransitionCandidate,
): ModelRouteTransition {
  const previousIdentity = context.latestTurn?.continuationIdentity
    ?? context.continuationIdentity;
  const previousModelId = context.latestTurn?.selection.modelId
    ?? (previousIdentity ? context.selection.modelId : null);
  const decision = resolveContinuationDecision({
    previousProviderId: providerIdForHarness(
      context.latestTurn?.selection.harnessId ?? context.selection.harnessId,
    ) ?? context.providerId,
    hasHistory: context.hasHistory,
    mixedProviderHistory: context.mixedProviderHistory,
    previousIdentity,
    nextIdentity: candidate.continuationIdentity,
    previousModelId,
    nextModelId: candidate.selection.modelId,
    hasProviderSession: context.hasProviderSession,
    hasTurns: context.latestTurn !== null,
    allowsModelSwitchWithinSession: officiallyAllowsModelSwitchWithinSession(
      candidate.compatibility,
    ),
    allowsPerformanceModeSwitchWithinSession:
      officiallyAllowsFastModeSwitchWithinSession({
        ...candidate.compatibility,
        harnessId: candidate.selection.harnessId,
      }) && candidate.supportsNativeFastModeControl === true,
  });
  const base: ModelRouteTransitionBase = {
    projectId: context.projectId,
    selection: candidate.selection,
    changeKind: decision.changeKind,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
  };

  if (decision.action === "new-conversation-required") {
    return {
      ...base,
      kind: "create-new-conversation",
      providerSessionDisposition: "start-unbound",
      continuationAction: decision.action,
    };
  }

  return {
    ...base,
    kind: "update-current-conversation",
    providerSessionDisposition: "retain-current-conversation",
    continuationAction: decision.action,
  };
}
