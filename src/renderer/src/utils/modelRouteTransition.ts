import { providerIdForHarness } from "../../../shared/model-routing";
import type {
  ContinuationIdentity,
  Conversation,
  HarnessBackendCompatibility,
  ModelSelection,
  ProviderId,
} from "@shared/contracts";
import {
  conversationHasHistory,
  officiallyAllowsFastModeSwitchWithinSession,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
  type ContinuationAction,
  type ContinuationChangeKind,
  type ContinuationReasonCode,
} from "../../../shared/continuation-policy";

type TransitionCompatibility = Pick<
  HarnessBackendCompatibility,
  "state" | "allowsModelSwitchWithinSession"
>;

export interface ModelRouteTransitionContext {
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
}

export interface ModelRouteTransitionCandidate {
  selection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  compatibility: TransitionCompatibility;
  /** Current exact-model evidence that both Fast and Standard are forceable. */
  supportsNativeFastModeControl?: boolean;
}

/**
 * A route change always stays in the current chat. A provider change starts a
 * fresh provider session that receives the chat's earlier messages as context.
 */
export interface ModelRouteTransition {
  selection: ModelSelection;
  continuationAction: ContinuationAction;
  changeKind: ContinuationChangeKind;
  reasonCode: ContinuationReasonCode;
  reason: string;
}

export function modelRouteTransitionContext(
  conversation: Conversation,
  latestTurn: { modelSelection: ModelSelection; continuationIdentity: ContinuationIdentity } | null,
): ModelRouteTransitionContext {
  return {
    providerId: conversation.providerId,
    selection: conversation.modelSelection,
    continuationIdentity: conversation.continuationIdentity,
    latestTurn: latestTurn
      ? { selection: latestTurn.modelSelection, continuationIdentity: latestTurn.continuationIdentity }
      : null,
    hasProviderSession: Boolean(conversation.providerSessionId),
    hasHistory: conversationHasHistory(conversation),
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
  return {
    selection: candidate.selection,
    continuationAction: decision.action,
    changeKind: decision.changeKind,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
  };
}
