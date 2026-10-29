import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AppSnapshot,
  ClientCommand,
} from "../../shared/contracts";
import { detachedContextRequestShareable } from "./detached-chat-runtime-projection";
import type { RuntimeClientAuthority } from "./runtime-client-authority";

const REJECTION = "That request is unavailable in a detached chat.";

export interface DetachedChatRuntimePolicyResources {
  snapshot(): AppSnapshot;
  subagentConversationId(traceId: string): string | null;
  checkpointConversationId(checkpointId: string): string | null;
  turnConversationId(turnId: string): string | null;
  duoLaunchConversationIds(launchId: string): readonly string[] | null;
  pendingApproval(
    conversationId: string,
    requestId: string,
  ): AgentApprovalRequest | null;
  pendingInput(
    conversationId: string,
    requestId: string,
  ): AgentInputRequest | null;
  secretRequestConversationId(requestId: string): string | null;
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
  let cachedSnapshot: AppSnapshot | null = null;
  const snapshot = (): AppSnapshot =>
    cachedSnapshot ??= resources.snapshot();
  const shell = (): AppSnapshot["conversations"][number] | null =>
    snapshot().conversations.find(
      ({ id }) => id === authority.conversationId,
    ) ?? null;
  const ownsExistingConversation = (candidate: string): boolean =>
    Boolean(shell() && owns(candidate));
  const ownsWorkspace = (
    payload: { projectId: string; conversationId?: string },
  ): boolean => {
    const conversation = shell();
    return Boolean(
      conversation
      && payload.projectId === conversation.projectId
      && payload.conversationId !== undefined
      && owns(payload.conversationId),
    );
  };
  const ownsTurn = (turnId: string): boolean =>
    resources.turnConversationId(turnId) === authority.conversationId;
  const ownsRun = (runId: string): boolean => snapshot().runs.some(
    ({ id, conversationId }) =>
      id === runId && conversationId === authority.conversationId,
  );

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
    case "conversation.limit-reset.get":
    case "conversation.limit-reset.schedule":
    case "conversation.limit-reset.cancel":
    case "conversation.limit-reset.resume":
    case "conversation.limit-reset.snooze":
    case "message.queue.get":
    case "message.queue.enqueue":
    case "message.queue.remove":
    case "message.queue.send":
    case "message.queue.stop-and-send":
    case "conversation.background-tasks.get":
    case "conversation.settle":
    case "conversation.unsettle":
    case "conversation.mark-unread":
    case "conversation.regenerate-title":
    case "review.state.set":
    case "review.note.create":
    case "review.note.update":
    case "review.note.delete":
    case "review.selection.cancel":
    case "review.summary.cancel":
      return ownsExistingConversation(command.payload.conversationId)
        ? null
        : REJECTION;
    case "message.send":
    case "conversation.compact-and-send":
      return ownsExistingConversation(command.payload.conversationId)
        && command.payload.activate === false
        && !command.payload.context?.conversationContextPacketIds?.length
        ? null
        : REJECTION;
    case "conversation.context.agent.source.load":
    case "conversation.context.agent.respond": {
      const { contextRequestId, targetConversationId } = command.payload;
      const pending = resources.pendingInput(
        targetConversationId,
        contextRequestId,
      );
      const contextRequest = pending?.conversationContextRequest;
      if (
        !ownsExistingConversation(targetConversationId)
        || pending?.conversationId !== authority.conversationId
        || !contextRequest
        || contextRequest.requestId !== contextRequestId
        || !detachedContextRequestShareable(contextRequest)
      ) return REJECTION;
      const payload = command.payload;
      if ("decision" in payload && payload.decision === "cancel") return null;
      return payload.sourceConversationId
        === contextRequest.requestedSourceConversationId
        ? null
        : REJECTION;
    }
    case "conversation.context.source.load":
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
          "title",
          "pinned",
          "snoozedUntil",
        ])
        && Object.keys(command.payload).length > 1
        ? null
        : REJECTION;
    case "agent.subagent.stop": {
      if (!ownsExistingConversation(command.payload.conversationId)) {
        return REJECTION;
      }
      return resources.subagentConversationId(command.payload.traceId) === authority.conversationId
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
    case "secret-request.decline":
      return ownsExistingConversation(command.payload.conversationId)
        && resources.secretRequestConversationId(command.payload.requestId)
          === authority.conversationId
        ? null
        : REJECTION;
    case "secret-request.revoke":
      return shell()
        && resources.secretRequestConversationId(command.payload.requestId)
          === authority.conversationId
        ? null
        : REJECTION;
    case "secret-request.list":
      return REJECTION;
    case "checkpoint.revert":
      return ownsExistingConversation(command.payload.conversationId)
        && resources.checkpointConversationId(command.payload.checkpointId)
          === authority.conversationId
        ? null
        : REJECTION;
    case "activity.mark-seen":
    case "activity.acknowledge":
    case "activity.stop":
    case "activity.dismiss":
      return ownsRun(command.payload.runId) ? null : REJECTION;
    case "git.refresh":
    case "git.diff":
    case "git.workspace.refresh":
    case "git.workspace.diff":
    case "git.selection.inspect":
    case "git.selection.revert":
    case "git.selection.undo":
    case "git.branches":
    case "git.branch.create":
    case "git.branch.switch":
    case "git.fetch":
    case "git.pull":
    case "git.commit":
    case "git.push":
    case "git.pr.open":
    case "git.pr.confidence":
    case "git.pr.create":
    case "review.selection.ask":
    case "review.selection.revise":
    case "review.summary.generate":
    case "workspace.entries":
    case "workspace.file.read":
    case "workspace.file.write":
    case "project.actions":
    case "project.action.run":
    case "terminal.create":
    case "terminal.attach":
    case "terminal.provider.resume":
      return ownsWorkspace(command.payload) ? null : REJECTION;
    case "git.turn.diff":
      return ownsWorkspace(command.payload)
        && ownsTurn(command.payload.turnId)
        ? null
        : REJECTION;
    case "git.turn.compare":
      return ownsWorkspace(command.payload)
        && ownsTurn(command.payload.earlierTurnId)
        && ownsTurn(command.payload.laterTurnId)
        ? null
        : REJECTION;
    case "terminal.input":
    case "terminal.resize":
    case "terminal.detach":
    case "terminal.close":
    case "usage.limits.get":
    case "prompt-preset.create":
    case "prompt-preset.update":
    case "prompt-preset.duplicate":
    case "prompt-preset.delete":
    case "prompt-preset.reorder":
      return null;
    case "duo.pending": {
      const conversation = shell();
      return conversation
        && command.payload.projectIds.every(
          (projectId) => projectId === conversation.projectId,
        )
        ? null
        : REJECTION;
    }
    case "duo.status":
    case "duo.comparison.retry":
    case "duo.comparison.cancel":
      return shell()
        && resources.duoLaunchConversationIds(command.payload.launchId)
          ?.includes(authority.conversationId)
        ? null
        : REJECTION;
    case "provider.refresh": {
      const conversation = shell();
      return conversation
        && command.payload.providerId === conversation.providerId
        ? null
        : REJECTION;
    }
    case "backend.profile.probe": {
      const conversation = shell();
      return conversation
        && command.payload.profileId
          === conversation.modelSelection.backendProfileId
        && command.payload.modelIds?.length === 1
        && command.payload.modelIds[0] === conversation.modelSelection.modelId
        ? null
        : REJECTION;
    }
    case "settings.update":
      return Object.keys(command.payload).length === 1
        && command.payload.usageDisplayMode !== undefined
        ? null
        : REJECTION;
    default:
      return REJECTION;
  }
}
