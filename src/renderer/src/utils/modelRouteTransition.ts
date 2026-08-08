import type {
  AppSettings,
  ContinuationIdentity,
  HarnessBackendCompatibility,
  ModelSelection,
} from "@shared/contracts";
import {
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
  type ContinuationChangeKind,
  type ContinuationReasonCode,
} from "../../../shared/continuation-policy";
import {
  buildNewConversationPayload,
  type NewConversationLocation,
  type NewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";

type TransitionCompatibility = Pick<
  HarnessBackendCompatibility,
  "state" | "allowsModelSwitchWithinSession"
>;

export interface ModelRouteTransitionContext {
  /** The selected project is carried across a required new-conversation path. */
  projectId: string;
  selection: ModelSelection;
  continuationIdentity: ContinuationIdentity | null;
  latestTurn: {
    selection: ModelSelection;
    continuationIdentity: ContinuationIdentity;
  } | null;
  /** Only session presence is accepted; session identifiers never enter this policy. */
  hasProviderSession: boolean;
}

export interface ModelRouteTransitionCandidate {
  selection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  compatibility: TransitionCompatibility;
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
    previousIdentity,
    nextIdentity: candidate.continuationIdentity,
    previousModelId,
    nextModelId: candidate.selection.modelId,
    hasProviderSession: context.hasProviderSession,
    hasTurns: context.latestTurn !== null,
    allowsModelSwitchWithinSession: officiallyAllowsModelSwitchWithinSession(
      candidate.compatibility,
    ),
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

/**
 * Builds the explicit new-conversation outcome from project and route data
 * only. Conversation IDs, continuation identities, and provider sessions are
 * intentionally outside the accepted transition shape.
 */
export function buildModelRouteConversationPayload(
  transition: Extract<ModelRouteTransition, { kind: "create-new-conversation" }>,
  settings: AppSettings,
  location: NewConversationLocation = { kind: "defaults" },
): NewConversationPayload {
  return withNewConversationModelSelection(
    buildNewConversationPayload(transition.projectId, settings, location),
    transition.selection,
  );
}
