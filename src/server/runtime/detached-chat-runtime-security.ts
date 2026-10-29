import { DetachedRuntimeCapabilityRegistry } from "../../node/detached-runtime-capability";
import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AppSnapshot,
  ClientCommand,
  DuoLaunchStatus,
} from "../../shared/contracts";
import {
  detachedChatCommandRejection,
  type DetachedChatRuntimePolicyResources,
} from "./detached-chat-runtime-policy";
import { pendingInteractionForConversation } from "./pending-interaction-registry";
import type { RuntimeClientAuthority } from "./runtime-client-authority";

interface DetachedChatRuntimeSecurityStore {
  subagentTrace(traceId: string): { conversationId: string };
  checkpoint(checkpointId: string): { conversationId: string };
  agentTurn(turnId: string): { conversationId: string };
  findPairedLaunch(launchId: string): Pick<DuoLaunchStatus, "sides" | "comparison"> | null;
  agentSecretRequests(): { find(requestId: string): { conversationId: string } | null };
}

interface DetachedChatRuntimeSecurityOptions {
  websocketPath: string;
  store: DetachedChatRuntimeSecurityStore;
  snapshot(): AppSnapshot;
  pendingApprovals: ReadonlyMap<string, AgentApprovalRequest>;
  pendingInputs: ReadonlyMap<string, AgentInputRequest>;
}

export interface DetachedChatCapabilityAdmission {
  conversationId: string;
  clientId: string;
  runtimeRequestUrl: string;
}

export interface DetachedChatRuntimeAuthorizationError {
  type: "request.error";
  requestId: string;
  message: string;
}

export interface DetachedChatRuntimeSecurity {
  activate(websocketUrl: string): void;
  authorizationError(
    authority: RuntimeClientAuthority,
    command: ClientCommand,
  ): DetachedChatRuntimeAuthorizationError | null;
  consumeCapability(
    requestUrl: string | undefined,
  ): DetachedChatCapabilityAdmission | null;
  visibleDuoLaunchIds(
    authority: RuntimeClientAuthority,
    launchIds: readonly string[],
  ): string[];
}

/**
 * Keeps detached-window admission and command authority closed over the same
 * runtime generation and authoritative stores. The renderer never supplies
 * these bindings.
 */
export function createDetachedChatRuntimeSecurity(
  options: DetachedChatRuntimeSecurityOptions,
): DetachedChatRuntimeSecurity {
  let capabilities: DetachedRuntimeCapabilityRegistry | null = null;
  const resources: DetachedChatRuntimePolicyResources = {
    snapshot: options.snapshot,
    subagentConversationId: (traceId) => {
      try {
        return options.store.subagentTrace(traceId).conversationId;
      } catch {
        return null;
      }
    },
    checkpointConversationId: (checkpointId) => {
      try {
        return options.store.checkpoint(checkpointId).conversationId;
      } catch {
        return null;
      }
    },
    turnConversationId: (turnId) => {
      try {
        return options.store.agentTurn(turnId).conversationId;
      } catch {
        return null;
      }
    },
    duoLaunchConversationIds: (launchId) => {
      const launch = options.store.findPairedLaunch(launchId);
      if (!launch) return null;
      return [
        ...launch.sides.map(({ conversationId }) => conversationId),
        launch.comparison?.conversationId ?? null,
      ].filter((conversationId) => conversationId !== null);
    },
    pendingApproval: (conversationId, requestId) =>
      pendingInteractionForConversation(
        options.pendingApprovals,
        conversationId,
        requestId,
      ) ?? null,
    pendingInput: (conversationId, requestId) =>
      pendingInteractionForConversation(
        options.pendingInputs,
        conversationId,
        requestId,
      ) ?? null,
    secretRequestConversationId: (requestId) =>
      options.store.agentSecretRequests().find(requestId)?.conversationId ?? null,
  };

  return {
    activate: (websocketUrl) => {
      if (capabilities) {
        throw new Error("Detached runtime security is already active.");
      }
      capabilities = new DetachedRuntimeCapabilityRegistry({
        websocketPath: options.websocketPath,
        secret: websocketUrl,
      });
    },
    authorizationError: (authority, command) => {
      const message = detachedChatCommandRejection(
        authority,
        command,
        resources,
      );
      return message
        ? { type: "request.error", requestId: command.requestId, message }
        : null;
    },
    consumeCapability: (requestUrl) => {
      if (!capabilities) return null;
      const verification = capabilities.verifyAndConsume(requestUrl);
      return verification.kind === "accepted"
        ? {
            conversationId: verification.authority.conversationId,
            clientId: verification.authority.clientId,
            runtimeRequestUrl: verification.runtimeRequestUrl,
          }
        : null;
    },
    visibleDuoLaunchIds: (authority, launchIds) =>
      authority.kind === "main"
        ? [...launchIds]
        : launchIds.filter((launchId) =>
            resources.duoLaunchConversationIds(launchId)
              ?.includes(authority.conversationId)),
  };
}
