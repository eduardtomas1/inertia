import type { Conversation, ProviderInfo } from "./contracts/app";
import type { ProviderId } from "./provider";
import {
  providerNativeBackendProfile,
  providerNativeHarnessId,
} from "./model-routing";

// This exact Cursor artifact is the version whose ACP and standalone CLI
// resume paths were inspected. Other builds remain unverified rather than
// being inferred compatible from version ordering alone.
export const CURSOR_ACP_TERMINAL_RESUME_VERIFIED_VERSION = "2026.08.04-aaa8809";

export interface ProviderTerminalResumeDescriptor {
  providerId: ProviderId;
  providerLabel: string;
  sessionId: string;
}

export type ProviderTerminalResumeAvailability =
  | {
      kind: "available";
      resume: ProviderTerminalResumeDescriptor;
      reason: null;
    }
  | {
      kind: "unavailable";
      resume: ProviderTerminalResumeDescriptor | null;
      reason: string;
    };

const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  gemini: "Gemini",
  kimi: "Kimi Code",
  opencode: "OpenCode",
};

const PROVIDER_TERMINAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export function isProviderTerminalSessionId(sessionId: string): boolean {
  return PROVIDER_TERMINAL_SESSION_ID.test(sessionId);
}

export function cursorVersionHasVerifiedAcpTerminalResume(
  version: string | null | undefined,
): boolean {
  return version === CURSOR_ACP_TERMINAL_RESUME_VERIFIED_VERSION;
}

export function hasNativeProviderTerminalSession(
  conversation: Pick<
    Conversation,
    "providerId" | "modelSelection" | "continuationIdentity" | "providerSessionId"
  >,
): boolean {
  const identity = conversation.continuationIdentity;
  const selection = conversation.modelSelection;
  const backend = providerNativeBackendProfile(conversation.providerId);
  const harnessId = providerNativeHarnessId(conversation.providerId);
  return Boolean(
    conversation.providerSessionId
    && identity
    && identity.harnessId === harnessId
    && identity.backendProfileId === backend.id
    && identity.backendConfigurationRevision === backend.configurationRevision
    && identity.endpointIdentity === backend.endpointIdentity
    && selection.harnessId === harnessId
    && selection.backendProfileId === backend.id
    && selection.backendConfigurationRevision === backend.configurationRevision,
  );
}

export function providerTerminalResumeAvailability(
  conversation: Pick<
    Conversation,
    "providerId" | "modelSelection" | "continuationIdentity" | "providerSessionId" | "status"
  >,
  provider: Pick<
    ProviderInfo,
    "id" | "label" | "available" | "version" | "installState" | "canRun" | "statusMessage"
  > | undefined,
): ProviderTerminalResumeAvailability {
  const providerLabel = provider?.label ?? PROVIDER_LABELS[conversation.providerId];
  const resume = conversation.providerSessionId
    ? {
        providerId: conversation.providerId,
        providerLabel,
        sessionId: conversation.providerSessionId,
      }
    : null;

  if (!conversation.providerSessionId) {
    return {
      kind: "unavailable",
      resume: null,
      reason: `No resumable ${providerLabel} CLI session is stored for this chat. It may be new or the saved provider session may be stale.`,
    };
  }
  if (conversation.providerId === "gemini") {
    return {
      kind: "unavailable",
      resume,
      reason: "Gemini conversations use bounded application-reconstructed context; Inertia does not expose Gemini ACP session IDs as provider-native terminal sessions.",
    };
  }
  if (!isProviderTerminalSessionId(conversation.providerSessionId)) {
    return {
      kind: "unavailable",
      resume: null,
      reason: `The saved ${providerLabel} session identifier is invalid or stale, so it cannot be passed to the terminal CLI.`,
    };
  }
  if (!hasNativeProviderTerminalSession(conversation)) {
    return {
      kind: "unavailable",
      resume,
      reason: `This chat does not use ${providerLabel}'s native CLI session store, so Inertia cannot resume it truthfully in a terminal.`,
    };
  }
  if (conversation.status === "running" || conversation.status === "needs-input") {
    return {
      kind: "unavailable",
      resume,
      reason: `Stop the active ${providerLabel} turn before resuming this session in a terminal.`,
    };
  }
  if (provider?.id !== conversation.providerId) {
    return {
      kind: "unavailable",
      resume,
      reason: `${providerLabel} availability has not been confirmed by the local runtime.`,
    };
  }
  if (
    conversation.providerId === "cursor"
    && !cursorVersionHasVerifiedAcpTerminalResume(provider.version)
  ) {
    return {
      kind: "unavailable",
      resume,
      reason: `This Cursor build is not verified to share ACP and terminal resume IDs. Verified build: ${CURSOR_ACP_TERMINAL_RESUME_VERIFIED_VERSION}.`,
    };
  }
  if (!provider.available || provider.installState !== "installed" || !provider.canRun) {
    return {
      kind: "unavailable",
      resume,
      reason: provider.statusMessage
        ? `${providerLabel} cannot resume this session: ${provider.statusMessage}.`
        : `${providerLabel} is not ready to resume this session in a terminal.`,
    };
  }
  return {
    kind: "available",
    resume: {
      providerId: conversation.providerId,
      providerLabel,
      sessionId: conversation.providerSessionId,
    },
    reason: null,
  };
}
