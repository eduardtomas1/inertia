import { providerIdForHarness, providerNativeBackendProfile } from "./model-routing";
import type { ProviderId } from "./provider";

import type {
  ContinuationIdentity,
  HarnessBackendCompatibility,
} from "./model-routing";
import type { ContinuationReasonCode } from "./continuation-reason-codes";

export {
  CONTINUATION_REASON_CODES,
  isContinuationReasonCode,
  isTurnSessionRecovery,
  type ContinuationReasonCode,
  type TurnSessionRecovery,
} from "./continuation-reason-codes";

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

export interface ContinuationDecision {
  action: ContinuationAction;
  changeKind: ContinuationChangeKind;
  reasonCode: ContinuationReasonCode;
  reason: string;
}

export const CHAT_PROVIDER_CHANGE_MESSAGE =
  "Start a new chat to use a different provider. This chat keeps its original provider and history.";

export const MIXED_PROVIDER_HISTORY_MESSAGE =
  "This chat's provider changed after some of its turns ran, so it can't continue here. Start a new chat to keep working; this chat keeps its history.";

export function conversationContinuationRefusal(
  conversation: { mixedProviderHistory?: boolean } | null | undefined,
): string | null {
  return conversation?.mixedProviderHistory === true ? MIXED_PROVIDER_HISTORY_MESSAGE : null;
}

export function isChatProviderRejection(error: unknown): error is Error {
  return error instanceof Error && [CHAT_PROVIDER_CHANGE_MESSAGE, MIXED_PROVIDER_HISTORY_MESSAGE]
    .some((message) => error.message.startsWith(message));
}

export function conversationHasHistory(conversation: { hasHistory?: boolean }): boolean {
  return conversation.hasHistory !== false;
}

export interface ContinuationDecisionInput {
  previousProviderId?: ProviderId;
  hasHistory?: boolean;
  mixedProviderHistory?: boolean;
  previousIdentity: ContinuationIdentity | null;
  nextIdentity: ContinuationIdentity;
  previousModelId: string | null;
  nextModelId: string;
  hasProviderSession: boolean;
  hasTurns: boolean;
  allowsModelSwitchWithinSession: boolean;
  allowsPerformanceModeSwitchWithinSession?: boolean;
}

const FRESH_PROVIDER_SESSION_OUTCOME =
  "The next turn will start a fresh provider session and preserve this chat's history.";

function freshProviderSessionReason(context: string): string {
  return `${context} ${FRESH_PROVIDER_SESSION_OUTCOME}`;
}

export function staleProviderSessionDecision(): ContinuationDecision {
  return {
    action: "start-session",
    changeKind: "missing-identity",
    reasonCode: "stale-provider-session",
    reason: freshProviderSessionReason(
      "The saved provider session is no longer available.",
    ),
  };
}

export function resumesAcrossProviderInstallation(
  identity: Pick<ContinuationIdentity, "harnessId" | "backendProfileId">,
): boolean {
  const providerId = providerIdForHarness(identity.harnessId);
  return providerId !== null
    && identity.backendProfileId === providerNativeBackendProfile(providerId).id;
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
        reason: freshProviderSessionReason(
          "This chat's saved agent-session identity is unavailable.",
        ),
      };
    case "harness":
      return {
        reasonCode: "harness-changed",
        reason: freshProviderSessionReason("The agent harness changed."),
      };
    case "backend-profile":
      return {
        reasonCode: "backend-profile-changed",
        reason: freshProviderSessionReason("The model backend changed."),
      };
    case "backend-configuration":
      return {
        reasonCode: "backend-configuration-changed",
        reason: freshProviderSessionReason(
          "This model backend was reconfigured; hidden provider context cannot cross that boundary.",
        ),
      };
    case "endpoint":
      return {
        reasonCode: "backend-endpoint-changed",
        reason: freshProviderSessionReason(
          "This model backend now points to a different endpoint.",
        ),
      };
    case "provider-installation": {
      const previousToken = previousIdentity?.providerCompatibilityToken;
      const nextToken = nextIdentity?.providerCompatibilityToken;
      const unverified = !previousToken || !nextToken;
      return unverified
        ? {
            reasonCode: "provider-installation-unverified",
            reason: freshProviderSessionReason(
              "The exact provider installation or capability contract could not be verified.",
            ),
          }
        : {
            reasonCode: "provider-installation-changed",
            reason: freshProviderSessionReason(
              "The provider installation or capability contract changed.",
            ),
      };
    }
    case "model":
      return {
        reasonCode: "incompatible-model-changed",
        reason: freshProviderSessionReason(
          "This agent cannot change models inside the existing provider session.",
        ),
      };
    case "performance-mode":
      return {
        reasonCode: "incompatible-performance-mode-changed",
        reason: freshProviderSessionReason(
          "Response speed cannot change inside the existing provider session.",
        ),
      };
  }
}

function startSessionDecision(
  changeKind: ContinuationChangeKind,
  established = false,
  previousIdentity?: ContinuationIdentity,
  nextIdentity?: ContinuationIdentity,
): ContinuationDecision {
  return {
    action: "start-session",
    changeKind,
    ...(established && changeKind !== "none"
      ? freshSessionReason(changeKind, previousIdentity, nextIdentity)
      : {
          reasonCode: "first-turn" as const,
          reason: "The first turn starts a new provider session.",
        }),
  };
}

/**
 * Decides whether provider-owned hidden state may be reused. The caller must
 * run this before persisting a new turn. Provider changes require a new chat;
 * same-provider session recovery keeps its existing continuation policy.
 */
export function resolveContinuationDecision(
  input: ContinuationDecisionInput,
): ContinuationDecision {
  const establishedConversation = input.hasTurns || input.hasProviderSession
    || input.hasHistory === true;
  const previousProviderId = input.previousProviderId
    ?? (input.previousIdentity ? providerIdForHarness(input.previousIdentity.harnessId) : null);
  const nextProviderId = providerIdForHarness(input.nextIdentity.harnessId);
  if (input.mixedProviderHistory || (establishedConversation && previousProviderId && nextProviderId
    && previousProviderId !== nextProviderId)) {
    return {
      action: "new-conversation-required",
      changeKind: "harness",
      reasonCode: "harness-changed",
      reason: input.mixedProviderHistory ? MIXED_PROVIDER_HISTORY_MESSAGE : CHAT_PROVIDER_CHANGE_MESSAGE,
    };
  }
  if (!input.previousIdentity) {
    return startSessionDecision(
      establishedConversation ? "missing-identity" : "none",
      establishedConversation,
    );
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
    return startSessionDecision("missing-identity", true);
  }

  const boundaryChange = identityChangeKind(
    input.previousIdentity,
    input.nextIdentity,
  );
  const installationChanged = boundaryChange === "provider-installation"
    && resumesAcrossProviderInstallation(input.nextIdentity);
  if (boundaryChange !== "none" && !installationChanged) {
    return startSessionDecision(
      boundaryChange,
      establishedConversation,
      input.previousIdentity,
      input.nextIdentity,
    );
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
    return startSessionDecision("model", establishedConversation);
  }

  if (
    performanceModeChanged
    && !input.allowsPerformanceModeSwitchWithinSession
  ) {
    return startSessionDecision("performance-mode", establishedConversation);
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
      : installationChanged
        ? {
            action: "resume-session",
            changeKind: "provider-installation",
            reasonCode: "same-continuation",
            reason: "The provider installation changed and its saved session is still in use.",
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
