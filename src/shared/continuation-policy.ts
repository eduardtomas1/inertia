import type {
  ContinuationIdentity,
  HarnessBackendCompatibility,
} from "./model-routing";

type ModelSwitchCompatibility = Pick<
  HarnessBackendCompatibility,
  "state" | "allowsModelSwitchWithinSession"
>;

/**
 * In-session model flexibility is an official capability only when the
 * compatibility itself is verified. A raw flag from partial, user-declared,
 * unknown, or unavailable evidence can never widen continuation authority.
 */
export function officiallyAllowsModelSwitchWithinSession(
  compatibility: ModelSwitchCompatibility,
): boolean {
  return compatibility.state === "verified"
    && compatibility.allowsModelSwitchWithinSession === true;
}

export const CONTINUATION_CHANGE_KINDS = [
  "none",
  "missing-identity",
  "harness",
  "backend-profile",
  "backend-configuration",
  "endpoint",
  "model",
] as const;

export type ContinuationChangeKind = (typeof CONTINUATION_CHANGE_KINDS)[number];

export const CONTINUATION_ACTIONS = [
  "start-session",
  "resume-session",
  "new-conversation-required",
] as const;

export type ContinuationAction = (typeof CONTINUATION_ACTIONS)[number];

export const CONTINUATION_REASON_CODES = [
  "first-turn",
  "same-continuation",
  "same-route-without-session",
  "supported-model-switch",
  "missing-continuation-identity",
  "harness-changed",
  "backend-profile-changed",
  "backend-configuration-changed",
  "backend-endpoint-changed",
  "incompatible-model-changed",
  "stale-provider-session",
] as const;

export type ContinuationReasonCode = (typeof CONTINUATION_REASON_CODES)[number];

export interface ContinuationDecision {
  action: ContinuationAction;
  changeKind: ContinuationChangeKind;
  reasonCode: ContinuationReasonCode;
  reason: string;
}

export interface ContinuationDecisionInput {
  previousIdentity: ContinuationIdentity | null;
  nextIdentity: ContinuationIdentity;
  previousModelId: string | null;
  nextModelId: string;
  hasProviderSession: boolean;
  hasTurns: boolean;
  allowsModelSwitchWithinSession: boolean;
}

export function staleProviderSessionDecision(): ContinuationDecision {
  return {
    action: "new-conversation-required",
    changeKind: "missing-identity",
    reasonCode: "stale-provider-session",
    reason: "The saved provider session is no longer available. Start a new chat to continue with a fresh agent context.",
  };
}

function identityChangeKind(
  previous: ContinuationIdentity,
  next: ContinuationIdentity,
): Exclude<ContinuationChangeKind, "missing-identity" | "model"> {
  if (previous.harnessId !== next.harnessId) return "harness";
  if (previous.backendProfileId !== next.backendProfileId) return "backend-profile";
  if (
    previous.backendConfigurationRevision
    !== next.backendConfigurationRevision
  ) return "backend-configuration";
  if (previous.endpointIdentity !== next.endpointIdentity) return "endpoint";
  return "none";
}

function newConversationReason(
  changeKind: Exclude<ContinuationChangeKind, "none">,
): Pick<ContinuationDecision, "reasonCode" | "reason"> {
  switch (changeKind) {
    case "missing-identity":
      return {
        reasonCode: "missing-continuation-identity",
        reason: "This chat's agent session identity is unavailable. Start a new chat to continue safely.",
      };
    case "harness":
      return {
        reasonCode: "harness-changed",
        reason: "Start a new chat to use a different agent harness. Existing chats keep their original agent context.",
      };
    case "backend-profile":
      return {
        reasonCode: "backend-profile-changed",
        reason: "Start a new chat to use a different model backend. Existing chats keep their original agent context.",
      };
    case "backend-configuration":
      return {
        reasonCode: "backend-configuration-changed",
        reason: "This model backend was reconfigured. Start a new chat so credentials and provider context cannot cross sessions.",
      };
    case "endpoint":
      return {
        reasonCode: "backend-endpoint-changed",
        reason: "This model backend now points to a different endpoint. Start a new chat to continue safely.",
      };
    case "model":
      return {
        reasonCode: "incompatible-model-changed",
        reason: "This agent cannot change models inside an existing session. Start a new chat to use the selected model.",
      };
  }
}

/**
 * Decides whether provider-owned hidden state may be reused. The caller must
 * run this before persisting a new turn so an identity mismatch can never
 * silently become a fresh provider session inside an existing conversation.
 */
export function resolveContinuationDecision(
  input: ContinuationDecisionInput,
): ContinuationDecision {
  const establishedConversation = input.hasTurns || input.hasProviderSession;
  if (!input.previousIdentity) {
    if (!establishedConversation) {
      return {
        action: "start-session",
        changeKind: "none",
        reasonCode: "first-turn",
        reason: "The first turn starts a new provider session.",
      };
    }
    const unavailable = newConversationReason("missing-identity");
    return {
      action: "new-conversation-required",
      changeKind: "missing-identity",
      ...unavailable,
    };
  }
  if (
    establishedConversation
    && (
      input.previousModelId === null
      || (
        input.previousIdentity.modelIdentity !== null
        && input.previousIdentity.modelIdentity !== input.previousModelId
      )
      || (
        input.nextIdentity.modelIdentity !== null
        && input.nextIdentity.modelIdentity !== input.nextModelId
      )
    )
  ) {
    const unavailable = newConversationReason("missing-identity");
    return {
      action: "new-conversation-required",
      changeKind: "missing-identity",
      ...unavailable,
    };
  }

  const boundaryChange = identityChangeKind(
    input.previousIdentity,
    input.nextIdentity,
  );
  if (boundaryChange !== "none") {
    if (!establishedConversation) {
      return {
        action: "start-session",
        changeKind: boundaryChange,
        reasonCode: "first-turn",
        reason: "The first turn starts a new provider session.",
      };
    }
    const changed = newConversationReason(boundaryChange);
    return {
      action: "new-conversation-required",
      changeKind: boundaryChange,
      ...changed,
    };
  }

  const modelChanged = input.previousModelId !== null
    && input.previousModelId !== input.nextModelId;
  const modelIdentityRequiresBoundary = input.nextIdentity.modelIdentity !== null;
  if (
    modelChanged
    && (
      modelIdentityRequiresBoundary
      || !input.allowsModelSwitchWithinSession
    )
  ) {
    if (!establishedConversation) {
      return {
        action: "start-session",
        changeKind: "model",
        reasonCode: "first-turn",
        reason: "The first turn starts a new provider session.",
      };
    }
    const changed = newConversationReason("model");
    return {
      action: "new-conversation-required",
      changeKind: "model",
      ...changed,
    };
  }

  if (input.hasProviderSession) {
    return modelChanged
      ? {
          action: "resume-session",
          changeKind: "model",
          reasonCode: "supported-model-switch",
          reason: "This provider supports changing models while preserving the current session.",
        }
      : {
          action: "resume-session",
          changeKind: "none",
          reasonCode: "same-continuation",
          reason: "The provider session identity matches this turn.",
        };
  }

  return {
    action: "start-session",
    changeKind: modelChanged ? "model" : "none",
    reasonCode: "same-route-without-session",
    reason: "No provider session is available, so this turn starts one on the same agent route.",
  };
}
