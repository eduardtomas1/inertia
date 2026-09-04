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

type FastModeSwitchCompatibility = Pick<
  HarnessBackendCompatibility,
  "harnessId" | "state"
>;

export function officiallyAllowsFastModeSwitchWithinSession(
  compatibility: FastModeSwitchCompatibility,
): boolean {
  return compatibility.state === "verified"
    && (
      compatibility.harnessId === "codex-app-server"
      || compatibility.harnessId === "claude-agent-sdk"
    );
}

export const CONTINUATION_CHANGE_KINDS = [
  "none",
  "missing-identity",
  "harness",
  "backend-profile",
  "backend-configuration",
  "endpoint",
  "provider-installation",
  "model",
  "performance-mode",
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
  "supported-performance-mode-switch",
  "missing-continuation-identity",
  "harness-changed",
  "backend-profile-changed",
  "backend-configuration-changed",
  "backend-endpoint-changed",
  "provider-installation-changed",
  "provider-installation-unverified",
  "incompatible-model-changed",
  "incompatible-performance-mode-changed",
  "stale-provider-session",
] as const;

export type ContinuationReasonCode = (typeof CONTINUATION_REASON_CODES)[number];

export const CONTINUATION_COMPATIBILITY_REJECTION_REASON_CODES = [
  "missing-continuation-identity",
  "harness-changed",
  "backend-profile-changed",
  "backend-configuration-changed",
  "backend-endpoint-changed",
  "provider-installation-changed",
  "provider-installation-unverified",
  "incompatible-model-changed",
  "incompatible-performance-mode-changed",
  "stale-provider-session",
] as const satisfies readonly ContinuationReasonCode[];

const CONTINUATION_REASON_CODE_SET = new Set<string>(
  CONTINUATION_REASON_CODES,
);
const CONTINUATION_REJECTION_REASON_CODE_SET = new Set<string>(
  CONTINUATION_COMPATIBILITY_REJECTION_REASON_CODES,
);

export function isContinuationReasonCode(
  value: unknown,
): value is ContinuationReasonCode {
  return typeof value === "string" && CONTINUATION_REASON_CODE_SET.has(value);
}

export function continuationRejectedForCompatibility(
  value: unknown,
): value is (typeof CONTINUATION_COMPATIBILITY_REJECTION_REASON_CODES)[number] {
  return typeof value === "string"
    && CONTINUATION_REJECTION_REASON_CODE_SET.has(value);
}

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
  allowsPerformanceModeSwitchWithinSession?: boolean;
}

export function staleProviderSessionDecision(): ContinuationDecision {
  return {
    action: "start-session",
    changeKind: "missing-identity",
    reasonCode: "stale-provider-session",
    reason: "The saved provider session is no longer available. This chat will keep its history and start a fresh provider session.",
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
  if (
    previous.providerCompatibilityToken === undefined
    || previous.providerCompatibilityToken === null
    || next.providerCompatibilityToken === undefined
    || next.providerCompatibilityToken === null
    || previous.providerCompatibilityToken
      !== next.providerCompatibilityToken
  ) return "provider-installation";
  return "none";
}

function freshSessionReason(
  changeKind: Exclude<ContinuationChangeKind, "none">,
  previousIdentity?: ContinuationIdentity,
  nextIdentity?: ContinuationIdentity,
): Pick<ContinuationDecision, "reasonCode" | "reason"> {
  switch (changeKind) {
    case "missing-identity":
      return {
        reasonCode: "missing-continuation-identity",
        reason: "This chat's saved agent-session identity is unavailable. Its history is preserved, and the next turn will start a fresh provider session.",
      };
    case "harness":
      return {
        reasonCode: "harness-changed",
        reason: "The agent harness changed. This chat will keep its history and start a fresh provider session.",
      };
    case "backend-profile":
      return {
        reasonCode: "backend-profile-changed",
        reason: "The model backend changed. This chat will keep its history and start a fresh provider session.",
      };
    case "backend-configuration":
      return {
        reasonCode: "backend-configuration-changed",
        reason: "This model backend was reconfigured. The next turn will start a fresh provider session so credentials and hidden provider context cannot cross the boundary.",
      };
    case "endpoint":
      return {
        reasonCode: "backend-endpoint-changed",
        reason: "This model backend now points to a different endpoint. The next turn will start a fresh provider session.",
      };
    case "provider-installation": {
      const previousToken = previousIdentity?.providerCompatibilityToken;
      const nextToken = nextIdentity?.providerCompatibilityToken;
      const unverified = !previousToken || !nextToken;
      return unverified
        ? {
            reasonCode: "provider-installation-unverified",
            reason: "The exact provider installation or capability contract could not be verified. This chat will keep its history and start a fresh provider session.",
          }
        : {
            reasonCode: "provider-installation-changed",
            reason: "The provider installation or capability contract changed. This chat will keep its history and start a fresh provider session.",
      };
    }
    case "model":
      return {
        reasonCode: "incompatible-model-changed",
        reason: "This agent cannot change models inside the existing provider session. The next turn will start a fresh session and keep this chat's history.",
      };
    case "performance-mode":
      return {
        reasonCode: "incompatible-performance-mode-changed",
        reason: "Response speed cannot change inside the existing provider session. The next turn will start a fresh session.",
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
    const unavailable = freshSessionReason("missing-identity");
    return {
      action: "start-session",
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
    const unavailable = freshSessionReason("missing-identity");
    return {
      action: "start-session",
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
    const changed = freshSessionReason(
      boundaryChange,
      input.previousIdentity,
      input.nextIdentity,
    );
    return {
      action: "start-session",
      changeKind: boundaryChange,
      ...changed,
    };
  }

  const modelChanged = input.previousModelId !== null
    && input.previousModelId !== input.nextModelId;
  const performanceModeChanged = (
    input.previousIdentity.performanceModeIdentity ?? null
  ) !== (input.nextIdentity.performanceModeIdentity ?? null);
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
    const changed = freshSessionReason("model");
    return {
      action: "start-session",
      changeKind: "model",
      ...changed,
    };
  }

  if (
    performanceModeChanged
    && !input.allowsPerformanceModeSwitchWithinSession
  ) {
    if (!establishedConversation) {
      return {
        action: "start-session",
        changeKind: "performance-mode",
        reasonCode: "first-turn",
        reason: "The first turn starts a new provider session.",
      };
    }
    const changed = freshSessionReason("performance-mode");
    return {
      action: "start-session",
      changeKind: "performance-mode",
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
      : performanceModeChanged
        ? {
            action: "resume-session",
            changeKind: "performance-mode",
            reasonCode: "supported-performance-mode-switch",
            reason: "Response speed can change in this session.",
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
    changeKind: modelChanged
      ? "model"
      : performanceModeChanged
        ? "performance-mode"
        : "none",
    reasonCode: "same-route-without-session",
    reason: "No provider session is available, so this turn starts one on the same agent route.",
  };
}
