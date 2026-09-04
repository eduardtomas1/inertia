import { DetachedRuntimeCapabilityRegistry } from "../../node/detached-runtime-capability";
import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AppSnapshot,
  ClientCommand,
  ConversationDetail,
} from "../../shared/contracts";
import {
  detachedChatCommandRejection,
  type DetachedChatRuntimePolicyResources,
} from "./detached-chat-runtime-policy";
import { pendingInteractionForConversation } from "./pending-interaction-registry";
import type { RuntimeClientAuthority } from "./runtime-client-authority";

interface DetachedChatRuntimeSecurityStore {
  conversationDetail(conversationId: string): ConversationDetail | null;
  checkpoint(checkpointId: string): { conversationId: string };
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
    detail: (conversationId) => {
      try {
        return options.store.conversationDetail(conversationId);
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
  };
}
