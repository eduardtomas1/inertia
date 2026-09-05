import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AppSnapshot,
  ClientCommand,
  ConversationDetail,
} from "../../shared/contracts";
import type { RuntimeClientAuthority } from "./runtime-client-authority";

const REJECTION = "That request is unavailable in a detached chat.";

export interface DetachedChatRuntimePolicyResources {
  snapshot(): AppSnapshot;
  detail(conversationId: string): ConversationDetail | null;
  checkpointConversationId(checkpointId: string): string | null;
  pendingApproval(
    conversationId: string,
    requestId: string,
  ): AgentApprovalRequest | null;
  pendingInput(
    conversationId: string,
    requestId: string,
  ): AgentInputRequest | null;
}

function exactConversation(
  candidate: string,
  authority: Extract<RuntimeClientAuthority, { kind: "detached-chat" }>,
): boolean {
  return candidate === authority.conversationId;
}

function onlyKeys(value: object, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

/** Returns a renderer-safe rejection, or null when the command is authorized. */
export function detachedChatCommandRejection(
  authority: RuntimeClientAuthority,
  command: ClientCommand,
  resources: DetachedChatRuntimePolicyResources,
): string | null {
  if (authority.kind === "main") return null;

  const owns = (candidate: string): boolean =>
    exactConversation(candidate, authority);
  const snapshot = resources.snapshot();
  const shell = snapshot.conversations.find(
    ({ id }) => id === authority.conversationId,
  ) ?? null;
  const ownsExistingConversation = (candidate: string): boolean =>
    Boolean(shell && owns(candidate));

  switch (command.type) {
    case "conversation.detail.subscription":
      return command.payload.conversationId === null
        || owns(command.payload.conversationId)
        ? null
        : REJECTION;
    case "conversation.detail.load":
      return owns(command.payload.conversationId) ? null : REJECTION;
    case "agent.workflow.load":
    case "agent.workflow.saved.load":
    case "agent.skills.list":
    case "agent.goal.set":
    case "agent.goal.clear":
    case "agent.stop":
    case "conversation.compact":
      return ownsExistingConversation(command.payload.conversationId)
        ? null
        : REJECTION;
    case "message.send":
      return ownsExistingConversation(command.payload.conversationId)
        && command.payload.activate === false
        && !command.payload.context?.conversationContextPacketIds?.length
        ? null
        : REJECTION;
    case "conversation.context.source.load":
    case "conversation.context.agent.source.load":
    case "conversation.context.agent.respond":
    case "conversation.context.create":
    case "conversation.context.load":
    case "conversation.context.remove":
      return REJECTION;
    case "conversation.update":
      return ownsExistingConversation(command.payload.conversationId)
        && onlyKeys(command.payload, [
          "conversationId",
          "providerId",
          "modelSelection",
          "interactionMode",
          "accessMode",
        ])
        && Object.keys(command.payload).length > 1
        ? null
        : REJECTION;
    case "agent.subagent.stop": {
      if (!ownsExistingConversation(command.payload.conversationId)) {
        return REJECTION;
      }
      const detail = resources.detail(authority.conversationId);
      return detail?.subagents.some(({ id }) => id === command.payload.traceId)
        ? null
        : REJECTION;
    }
    case "agent.approval.respond": {
      const pending = resources.pendingApproval(
        command.payload.conversationId,
        command.payload.requestId,
      );
      return ownsExistingConversation(command.payload.conversationId)
        && pending?.conversationId === authority.conversationId
        ? null
        : REJECTION;
    }
    case "agent.input.respond": {
      const pending = resources.pendingInput(
        command.payload.conversationId,
        command.payload.requestId,
      );
      return ownsExistingConversation(command.payload.conversationId)
        && pending?.conversationId === authority.conversationId
        && !pending.conversationContextRequest
        ? null
        : REJECTION;
    }
    case "checkpoint.revert":
      return ownsExistingConversation(command.payload.conversationId)
        && resources.checkpointConversationId(command.payload.checkpointId)
          === authority.conversationId
        ? null
        : REJECTION;
    case "activity.mark-seen":
      return snapshot.runs.some(
        ({ id, conversationId }) =>
          id === command.payload.runId
          && conversationId === authority.conversationId,
      ) ? null : REJECTION;
    case "workspace.entries":
      return shell
        && command.payload.conversationId === authority.conversationId
        && command.payload.projectId === shell.projectId
        && command.payload.query
        && command.payload.directory === undefined
        ? null
        : REJECTION;
    case "provider.refresh":
      return shell && command.payload.providerId === shell.providerId
        ? null
        : REJECTION;
    case "backend.profile.probe":
      return shell
        && command.payload.profileId
          === shell.modelSelection.backendProfileId
        && command.payload.modelId === shell.modelSelection.modelId
        ? null
        : REJECTION;
    case "settings.update":
      return Object.keys(command.payload).length === 1
        && command.payload.usageDisplayMode !== undefined
        ? null
        : REJECTION;
    default:
      return REJECTION;
  }
}
