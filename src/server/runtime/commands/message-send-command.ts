import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

import type { Conversation, ModelSelection, TurnRequestContext } from "../../../shared/contracts";
import { MAX_CHAT_ATTACHMENT_BYTES, isExtractedDocumentAttachmentMimeType } from "../../../shared/attachments";
import { supportsActiveParentFollowUp } from "../../../shared/follow-up-steer";
import { providerIdForHarness } from "../../../shared/model-routing";
import { OrchestrationConflict, type CommandSource, type JsonValue } from "../../orchestration-v2/types";
import { hasIncompleteWorktreeSetup } from "../../workspace-path-authority";
import { MESSAGE_ADMISSION_UNAVAILABLE, RuntimeRequestError } from "../../runtime-errors";
import { setFollowUpQueueHint } from "../queue-follow-up-hints";
import { providerImageRequestLimitError } from "../../provider/provider-image-read";
import { CHECKOUT_RESTORE_IN_PROGRESS } from "../conversation-work-authority";
import {
  prepareDocumentAttachments,
  type PreparedDocumentAttachments,
} from "../attachments/document-attachment-context";
import { DocumentAttachmentError } from "../attachments/attachment-errors";
import type { TrustedAttachmentResolver } from "../attachments/trusted-attachment-resolver";
import type { AgentWorkflowController } from "../agent-workflow-controller";
import type { TurnController } from "../turns/turn-controller";
import type { FollowUpAdmissionLease } from "../turns/turn-controller-types";
import { UNKNOWN_FOLLOW_UP_DELIVERY } from "../turns/turn-follow-up-coordinator";
import { QueuedSelectionProviderUnavailableError } from "../turns/turn-request-preparation";
import { ConversationContextService } from "../conversation-context-service";
import { isUntitledConversationTitle, quickConversationTitle } from "../conversation-title";
import { isHeld, UPDATE_HOLD_MESSAGE } from "../update-hold";
import { commandRejection } from "./command-rejection";
import { deliverFollowUpAfterTurn, sendActiveFollowUp } from "./message-follow-up-command";
import {
  assertMessageSendPreparationPending,
  awaitMessageSendPreparation,
  messageSendPreparationDeadline,
} from "./message-send-preparation";
import {
  classifiedMessageSendError,
  FOLLOW_UP_ROUTE_UNAVAILABLE,
  internalDispatchOrigin,
  messageSendSource,
  replyChannel,
  replyJson,
  sendJoinedReply,
  type CommandReply,
  type MessageSendCommand,
  type MessageSendStage,
  type ReplyChannel,
} from "./message-send-support";
import type { TurnInteractionCommandDependencies } from "./turn-interaction-types";

type SendRoute =
  | { kind: "replied"; reply: CommandReply }
  | { kind: "after-turn"; steerWhenReadyRunId?: string }
  | { kind: "follow-up"; admission: FollowUpAdmissionLease }
  | { kind: "new-turn"; handedOff: boolean; contextPacketIds: readonly string[]; resolvedTurnContext: TurnRequestContext | undefined };

export const QUEUE_CLAIM_SUPERSEDED_CODE = "queue-claim-superseded";

export interface SendMessageCommandOptions {
  modelSelectionOverride?: ModelSelection;
  resumeSessionId?: string | null;
}

const inFlightSendContent = new Map<string, string>();

function queuedSelectionOverrideFor(
  dependencies: TurnInteractionCommandDependencies,
): ModelSelection | null {
  const queued = dependencies.queuedMessage;
  if (!queued || queued.followsThreadSelection || queued.delegatedCompletion || queued.watcherNote) {
    return null;
  }
  return queued.modelSelection ?? null;
}

function selectionOverrideFor(
  dependencies: TurnInteractionCommandDependencies,
  options?: SendMessageCommandOptions,
): ModelSelection | null {
  return options?.modelSelectionOverride ?? queuedSelectionOverrideFor(dependencies);
}

function effectiveSelectionFor(
  dependencies: TurnInteractionCommandDependencies,
  conversation: Conversation,
  options?: SendMessageCommandOptions,
): ModelSelection {
  return selectionOverrideFor(dependencies, options) ?? conversation.modelSelection;
}

function effectiveProviderIdFor(
  dependencies: TurnInteractionCommandDependencies,
  conversation: Conversation,
  options?: SendMessageCommandOptions,
): Conversation["providerId"] {
  const override = selectionOverrideFor(dependencies, options);
  return override
    ? (providerIdForHarness(override.harnessId) ?? conversation.providerId)
    : conversation.providerId;
}

function resolveSkillsForSend(
  workflows: AgentWorkflowController,
  conversationId: string,
  content: string,
  effectiveConversation?: Conversation,
): ReturnType<AgentWorkflowController["resolveTurnSkills"]> {
  if (!effectiveConversation) {
    return workflows.resolveTurnSkills(conversationId, content);
  }
  return (
    workflows.resolveTurnSkills as (
      id: string,
      text: string,
      effective?: Conversation,
    ) => ReturnType<AgentWorkflowController["resolveTurnSkills"]>
  )(conversationId, content, effectiveConversation);
}

function assertTurnSkillsCurrentForSend(
  workflows: AgentWorkflowController,
  conversationId: string,
  routeKey: string | null,
  effectiveConversation?: Conversation,
): void {
  if (!effectiveConversation) {
    workflows.assertTurnSkillsCurrent(conversationId, routeKey);
    return;
  }
  (
    workflows.assertTurnSkillsCurrent as (
      id: string,
      key: string | null,
      effective?: Conversation,
    ) => void
  )(conversationId, routeKey, effectiveConversation);
}

function assertQueuedClaimCurrent(
  dependencies: TurnInteractionCommandDependencies,
  conversation: Conversation,
): void {
  const queued = dependencies.queuedMessage;
  if (!queued) return;
  const item = dependencies.store.queuedMessages.get(conversation.id, queued.id);
  const v2Item = dependencies.store.orchestration?.queue?.getItem(queued.id) ?? null;
  const claimInvalid = v2Item
    ? (
        v2Item.threadId !== conversation.id
        || v2Item.state !== "dispatching"
        || v2Item.queueHeld
        || (queued.dispatchOrdinal !== undefined && v2Item.dispatchOrdinal !== queued.dispatchOrdinal)
        || (queued.editRevision !== undefined && v2Item.contentRef.editRevision !== queued.editRevision)
      )
    : item?.state !== "dispatching";
  if (claimInvalid || item?.state !== "dispatching") {
    throw new RuntimeRequestError(
      "The queued message claim was held or superseded before admission.",
      QUEUE_CLAIM_SUPERSEDED_CODE,
    );
  }
  if (conversation.archivedAt !== null || !queuedWorkspaceMatches(dependencies, conversation)) {
    throw new RuntimeRequestError("The chat changed while its queued message was being prepared.");
  }
}

function verifyMessageSendReplayContent(
  dependencies: TurnInteractionCommandDependencies,
  conversationId: string,
  command: MessageSendCommand,
  receipt: { result: JsonValue } | null,
): void {
  const expectedText = command.payload.content.trim();
  const inFlightKey = `${conversationId}:${command.requestId}`;
  if (receipt === null) {
    const activeText = inFlightSendContent.get(inFlightKey);
    if (activeText !== undefined && activeText !== expectedText) {
      throw new OrchestrationConflict("command-conflict");
    }
    return;
  }
  const recorded = (receipt.result !== null && typeof receipt.result === "object" && !Array.isArray(receipt.result)
    ? receipt.result : {}) as { readonly [key: string]: JsonValue | undefined };
  if (typeof recorded.turnId === "string") {
    try {
      const turn = dependencies.store.agentTurn(recorded.turnId);
      const message = dependencies.store.message(turn.userMessageId);
      if (message.content.trim() !== expectedText) throw new OrchestrationConflict("command-conflict");
    } catch (error) {
      if (error instanceof OrchestrationConflict) throw error;
    }
    return;
  }
  if (recorded.disposition === "queued" && typeof recorded.queuedMessageId === "string") {
    dependencies.store.orchestration.queue.verifyEnqueueReplay(
      conversationId,
      recorded.queuedMessageId,
      command.payload.content,
      command.payload.attachments,
    );
    return;
  }
  if (recorded.disposition === "follow-up" && typeof recorded.effectId === "string") {
    const steer = dependencies.store.orchestration.runControl.steer(recorded.effectId);
    if (steer?.messageId) {
      try {
        const message = dependencies.store.message(steer.messageId);
        if (message.content.trim() !== expectedText) throw new OrchestrationConflict("command-conflict");
      } catch (error) {
        if (error instanceof OrchestrationConflict) throw error;
      }
    } else if (steer?.queuedMessageId) {
      dependencies.store.orchestration.queue.verifyEnqueueReplay(
        conversationId,
        steer.queuedMessageId,
        command.payload.content,
        command.payload.attachments,
      );
    }
  }
}

function queuedWorkspaceMatches(
  dependencies: TurnInteractionCommandDependencies,
  conversation: Conversation,
): boolean {
  const queued = dependencies.queuedMessage;
  if (!queued) return true;
  if (queued.delegatedCompletion || queued.followsThreadSelection) return true;
  if (dependencies.store.queuedMessages.routeMatches(queued, conversation)) return true;
  // Decision 4.3: accessMode and interactionMode changes do not block a queued item;
  // only workspace/project or model-route changes (when item has no explicit selection) block.
  const v2 = dependencies.store.orchestration.queue.getItem(queued.id);
  if (!v2?.routeIdentity) return false;
  try {
    const parsed: unknown = JSON.parse(v2.routeIdentity);
    if (!Array.isArray(parsed) || parsed.length < 8) return false;
    const sameWorkspace = parsed[0] === conversation.projectId && parsed[1] === conversation.worktreePath;
    if (!sameWorkspace) return false;
    if (v2.modelSelection !== undefined && v2.modelSelection !== null) return true;
    return parsed[2] === conversation.providerId
      && JSON.stringify(parsed[3]) === JSON.stringify(conversation.modelSelection);
  } catch {
    return false;
  }
}

interface NewTurnInput {
  dependencies: TurnInteractionCommandDependencies;
  command: MessageSendCommand;
  conversation: Conversation;
  route: Extract<SendRoute, { kind: "new-turn" }>;
  orchestrationRequest: CommandSource;
  origin: string | null;
  reply: ReplyChannel;
  options?: SendMessageCommandOptions;
}

export async function sendMessageCommand(
  dependencies: TurnInteractionCommandDependencies,
  socket: WebSocket,
  command: MessageSendCommand,
  options?: SendMessageCommandOptions,
): Promise<"handled"> {
  if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
  const origin = internalDispatchOrigin(dependencies);
  const baseRequest = messageSendSource(command, origin, dependencies.queuedMessage?.dispatchOrdinal);
  const orchestrationRequest: CommandSource = dependencies.queuedMessage
    ? {
        ...baseRequest,
        command: {
          ...(typeof baseRequest.command === "object" && baseRequest.command !== null && !Array.isArray(baseRequest.command)
            ? baseRequest.command
            : { value: baseRequest.command }),
          ...(dependencies.queuedMessage.dispatchOrdinal !== undefined
            ? { queuedDispatchOrdinal: dependencies.queuedMessage.dispatchOrdinal }
            : {}),
          ...(dependencies.queuedMessage.editRevision !== undefined
            ? { queuedEditRevision: dependencies.queuedMessage.editRevision }
            : {}),
        },
      }
    : baseRequest;
  let messageSendStage: MessageSendStage = "conversation-state";
  let conversation: Conversation;
  try {
    conversation = dependencies.store.conversation(command.payload.conversationId);
  } catch (error) {
    throw classifiedMessageSendError(error, messageSendStage);
  }
  const inFlightKey = `${conversation.id}:${command.requestId}`;
  const start = await dependencies.store.orchestration.authority.begin<SendRoute>({
    source: orchestrationRequest, threadId: conversation.id, projectId: conversation.projectId,
    commandType: "message.send", rejection: origin === null ? commandRejection : null,
    verifyReplayContent: origin === null
      ? (receipt) => verifyMessageSendReplayContent(dependencies, conversation.id, command, receipt)
      : undefined,
  }, () => {
    try {
      const route = routeMessageSend(dependencies, command, conversation, (stage) => { messageSendStage = stage; });
      if (origin === null) inFlightSendContent.set(inFlightKey, command.payload.content.trim());
      return route;
    } catch (error) {
      throw classifiedMessageSendError(error, messageSendStage);
    }
  });
  if (start.kind === "replay") {
    replayMessageSend(dependencies, socket, command, orchestrationRequest, start.receipt.result);
    return "handled";
  }
  if (start.kind === "rejected") throw new RuntimeRequestError(start.detail);
  if (start.kind === "joined") {
    sendJoinedReply(dependencies, socket, command.requestId, await start.result);
    return "handled";
  }
  const { ticket, intake: route } = start;
  const reply = replyChannel(dependencies, socket, command.requestId);
  try {
    if (route.kind === "replied") reply.send(route.reply);
    else if (route.kind === "after-turn") {
      if (route.steerWhenReadyRunId) {
        setFollowUpQueueHint(command.requestId, { steerWhenReadyRunId: route.steerWhenReadyRunId });
      }
      await deliverFollowUpAfterTurn({ dependencies, command, conversation, ticket, reply });
    } else if (route.kind === "follow-up") {
      await sendActiveFollowUp({ dependencies, command, conversation, ticket, reply }, route.admission);
    } else {
      await startNewTurn({ dependencies, command, conversation, route, orchestrationRequest, origin, reply, options });
    }
  } catch (error) {
    ticket.fail(error);
    throw error;
  } finally {
    if (origin === null) inFlightSendContent.delete(inFlightKey);
  }
  ticket.finish(replyJson(reply.sent));
  return "handled";
}

function routeMessageSend(
  dependencies: TurnInteractionCommandDependencies,
  command: MessageSendCommand,
  conversation: Conversation,
  enterStage: (stage: MessageSendStage) => void,
): SendRoute {
  const scheduledDispatch = dependencies.limitResetDispatch ?? dependencies.restartContinuationDispatch;
  const handedOff = dependencies.compactionHandoff?.conversationId === conversation.id;
  scheduledDispatch?.assertCurrent();
  if (dependencies.queuedMessage && (
    dependencies.queuedMessage.conversationId !== conversation.id
    || conversation.archivedAt !== null
    || dependencies.turns.isActive(conversation.id)
    || !queuedWorkspaceMatches(dependencies, conversation)
  )) throw new RuntimeRequestError("The chat changed before its queued message could start.");
  const contextPacketIds = command.payload.context?.conversationContextPacketIds ?? [];
  const resolvedTurnContext = command.payload.context;
  if (contextPacketIds.length > 0) {
    const contextService = new ConversationContextService(dependencies.store);
    const replay = contextService.replayAcceptance(command.requestId, conversation.id, contextPacketIds);
    if (replay) {
      return { kind: "replied", reply: replay.kind === "transcript-only"
        ? { type: "request.ok" }
        : { type: "request.result", result: replay } };
    }
    contextService.assertSendable(conversation.id, contextPacketIds);
  }
  enterStage("active-route");
  if (handedOff && (
    dependencies.turns.isActive(conversation.id)
    || !dependencies.providerTerminalResumes.isActive(conversation.id)
  )) {
    throw new RuntimeRequestError("The chat changed while it was compacting. Send the message again.");
  }
  if (!handedOff && dependencies.providerTerminalResumes.isActive(conversation.id)) {
    throw new RuntimeRequestError(
      "Wait for this chat's current operation (such as compaction) to finish. If you resumed it in a terminal, close that terminal first.",
    );
  }
  if (dependencies.turns.isActive(conversation.id)) {
    if (scheduledDispatch || dependencies.watcherDelivery || dependencies.delegatedDelivery) {
      throw new RuntimeRequestError("This chat is busy. Resume it manually when it is ready.");
    }
    enterStage("follow-up-preparation");
    if (command.payload.context !== undefined) {
      throw new RuntimeRequestError("Follow-ups while the agent is working cannot add workspace context.");
    }
    const stopping = dependencies.store.orchestration.runControl.interruptRequested(conversation.id);
    const admission = stopping ? null : dependencies.turns.acquireFollowUpAdmission(conversation.id);
    if (admission) return { kind: "follow-up", admission };
    const activeOwner = dependencies.turns.activeIdentity(conversation.id);
    if (!stopping && activeOwner && dependencies.undeliveredFollowUps
      && supportsActiveParentFollowUp(conversation.modelSelection.harnessId)
      && !dependencies.turns.followUpArrivedAfterTurn(conversation.id)) {
      return { kind: "after-turn", steerWhenReadyRunId: activeOwner.runId };
    }
    if (!dependencies.undeliveredFollowUps || (!stopping && !dependencies.turns.followUpArrivedAfterTurn(conversation.id))) {
      throw new RuntimeRequestError(FOLLOW_UP_ROUTE_UNAVAILABLE);
    }
    return { kind: "after-turn" };
  }
  if (dependencies.isolatedRuns.has(conversation.id)) {
    throw new RuntimeRequestError("Wait for the current run or read-only review to finish first.");
  }
  const db = dependencies.store.orchestration?.effects?.connection;
  if (db && hasIncompleteWorktreeSetup(db, conversation.id)) {
    throw new RuntimeRequestError("Retry worktree setup or choose a workspace before sending.");
  }
  return { kind: "new-turn", handedOff, contextPacketIds, resolvedTurnContext };
}

function replayMessageSend(
  dependencies: TurnInteractionCommandDependencies,
  socket: WebSocket,
  command: MessageSendCommand,
  orchestrationRequest: CommandSource,
  result: JsonValue,
): void {
  const reply = replyChannel(dependencies, socket, command.requestId);
  const conversationId = command.payload.conversationId;
  const recorded = (result !== null && typeof result === "object" && !Array.isArray(result)
    ? result : {}) as { readonly [key: string]: JsonValue | undefined };
  if (typeof recorded.turnId === "string") {
    const accepted = dependencies.store.orchestration.acceptedRequest(conversationId, orchestrationRequest);
    if (!accepted) throw new RuntimeRequestError(FOLLOW_UP_ROUTE_UNAVAILABLE);
    reply.send({ type: "request.result", result: { kind: "message.accepted", conversationId: accepted.turn.conversationId,
      turnId: accepted.turn.id, userMessageId: accepted.message.id, disposition: "new-turn" } });
    return;
  }
  const queuedMessageId = recorded.disposition === "queued" && typeof recorded.queuedMessageId === "string"
    ? recorded.queuedMessageId
    : null;
  if (queuedMessageId !== null) {
    reply.send(queuedReply(dependencies, conversationId, queuedMessageId));
    return;
  }
  const steer = recorded.disposition === "follow-up" && typeof recorded.effectId === "string"
    ? dependencies.store.orchestration.runControl.steer(recorded.effectId)
    : null;
  if (steer?.state !== "settled") {
    throw new RuntimeRequestError(UNKNOWN_FOLLOW_UP_DELIVERY, undefined, "ambiguous");
  }
  if (steer.outcome === "accepted" && steer.messageId) {
    const message = dependencies.store.message(steer.messageId);
    if (!message.turnId) throw new RuntimeRequestError(FOLLOW_UP_ROUTE_UNAVAILABLE);
    reply.send({ type: "request.result", result: { kind: "message.accepted", conversationId: message.conversationId,
      turnId: message.turnId, userMessageId: message.id, disposition: "follow-up" } });
    return;
  }
  if (steer.queuedMessageId) {
    reply.send(queuedReply(dependencies, conversationId, steer.queuedMessageId));
    return;
  }
  if (steer.outcome === "unconfirmed") throw new RuntimeRequestError(UNKNOWN_FOLLOW_UP_DELIVERY, undefined, "ambiguous");
  throw new RuntimeRequestError(FOLLOW_UP_ROUTE_UNAVAILABLE);
}

function queuedReply(
  dependencies: TurnInteractionCommandDependencies,
  conversationId: string,
  queuedMessageId: string,
): CommandReply {
  const result = dependencies.undeliveredFollowUps?.result?.(conversationId, queuedMessageId);
  if (!result) throw new RuntimeRequestError("This message was already queued. Open the chat's queue to see it.");
  return { type: "request.result", result };
}

async function startNewTurn(input: NewTurnInput): Promise<void> {
  const { dependencies, command, orchestrationRequest, origin, reply, options } = input;
  const { handedOff, contextPacketIds, resolvedTurnContext } = input.route;
  const scheduledDispatch = dependencies.limitResetDispatch ?? dependencies.restartContinuationDispatch;
  let conversation = input.conversation;
  let messageSendStage: MessageSendStage;
  const preparationDeadlineAt = messageSendPreparationDeadline();
  messageSendStage = "turn-admission";
  let turnAdmission: Awaited<
    ReturnType<TurnController["acquireTurnAdmission"]>
  >;
  const admissionAcquisition = dependencies.turns.acquireTurnAdmission(
    conversation.id,
    Math.max(0, preparationDeadlineAt - Date.now()),
  );
  try {
    turnAdmission = await awaitMessageSendPreparation(
      admissionAcquisition,
      preparationDeadlineAt,
    );
  } catch (error) {
    void admissionAcquisition.then((lateAdmission) => {
      lateAdmission?.release();
    }, () => undefined);
    throw classifiedMessageSendError(
      error,
      messageSendStage,
    );
  }
  if (!turnAdmission) {
    throw classifiedMessageSendError(
      new RuntimeRequestError(
        "Message admission did not become available. Try again in a moment.",
        MESSAGE_ADMISSION_UNAVAILABLE,
      ),
      messageSendStage,
    );
  }
  try {
  if (dependencies.store.conversationWork.restoreBlocksConversation(conversation.id)) {
    throw new RuntimeRequestError(CHECKOUT_RESTORE_IN_PROGRESS, MESSAGE_ADMISSION_UNAVAILABLE);
  }
  if (dependencies.prepareForkSession) {
    messageSendStage = "provider-transition";
    const preparation = new AbortController();
    await awaitMessageSendPreparation(dependencies.prepareForkSession(conversation.id, preparation.signal),
      preparationDeadlineAt, () => preparation.abort());
    conversation = dependencies.store.conversation(conversation.id);
  }
  messageSendStage = "attachments";
  const queuedSelectionOverride = queuedSelectionOverrideFor(dependencies);
  const selectionOverride = selectionOverrideFor(dependencies, options);
  const effectiveSelection = effectiveSelectionFor(dependencies, conversation, options);
  const effectiveProviderId = effectiveProviderIdFor(dependencies, conversation, options);
  const effectiveRouteDiffers = selectionOverride !== null && (
    effectiveProviderId !== conversation.providerId
    || effectiveSelection.harnessId !== conversation.modelSelection.harnessId
    || effectiveSelection.backendProfileId !== conversation.modelSelection.backendProfileId
    || effectiveSelection.backendConfigurationRevision !== conversation.modelSelection.backendConfigurationRevision
  );
  const skillConversation: Conversation | undefined = effectiveRouteDiffers
    ? { ...conversation, providerId: effectiveProviderId, modelSelection: effectiveSelection }
    : undefined;
  let resolvedAttachments: Awaited<
    ReturnType<TrustedAttachmentResolver["resolvePayloads"]>
  > = [];
  if (dependencies.queuedMessage) {
    const queuedImageLimit = dependencies.enableProviders
      ? providerImageRequestLimitError(effectiveProviderId, dependencies.queuedMessage.attachments)
      : null;
    if (queuedImageLimit) throw new RuntimeRequestError(queuedImageLimit);
    for (const attachment of dependencies.queuedMessage.attachments) {
      const readQueued = isExtractedDocumentAttachmentMimeType(attachment.mimeType)
        && attachment.size <= MAX_CHAT_ATTACHMENT_BYTES
        ? dependencies.conversationAttachments.preview(attachment.id)
        : dependencies.conversationAttachments.resolve(attachment.id);
      const preview = await awaitMessageSendPreparation(
        readQueued, preparationDeadlineAt,
      );
      if (!preview) throw new RuntimeRequestError("A queued image is no longer available. Remove this message and attach it again.");
      resolvedAttachments.push({ ...preview, attachment: { ...preview.attachment, ...(attachment.snapshot ? { snapshot: attachment.snapshot } : {}), ...(attachment.previewAnnotation ? { previewAnnotation: attachment.previewAnnotation } : {}) } });
    }
  } else if (handedOff && dependencies.compactionHandoff) {
    resolvedAttachments = [...dependencies.compactionHandoff.attachments];
    dependencies.compactionHandoff.attachmentsTaken = true;
  } else if (command.payload.attachments.length > 0) {
    const resolver = dependencies.attachmentResolver;
    if (!resolver) {
      throw new RuntimeRequestError(
        "The selected attachment is no longer available or could not be verified.",
      );
    }
    const resolutionAbort = new AbortController();
    resolvedAttachments = await awaitMessageSendPreparation(
      resolver.resolvePayloads(
        command.payload.attachments,
        command.requestId,
        resolutionAbort.signal,
      ),
      preparationDeadlineAt,
      () => resolutionAbort.abort(),
    );
  }
  const sourceAttachments = resolvedAttachments.map(
    ({ attachment }) => attachment,
  );
  const imageLimit = dependencies.enableProviders
    ? providerImageRequestLimitError(effectiveProviderId, sourceAttachments)
    : null;
  if (imageLimit) {
    await dependencies.attachmentResolver?.relinquishAll(sourceAttachments.map(({ id }) => id));
    throw new RuntimeRequestError(imageLimit);
  }
  let attachments = sourceAttachments;
  const attachmentRetentionId = randomUUID();
  let attachmentRetentionStarted = false;
  let retainedAttachmentsAccepted = false;
  let generatedAttachmentPaths: string[] = [];
  const acceptRetainedAttachments = () => {
    if (retainedAttachmentsAccepted) return;
    dependencies.conversationAttachments.acceptRetention(
      attachmentRetentionId,
    );
    retainedAttachmentsAccepted = true;
  };
  const relinquishAttachments = async () => {
    const generated = generatedAttachmentPaths;
    generatedAttachmentPaths = [];
    await Promise.all([
      dependencies.attachmentResolver?.relinquishAll(
        sourceAttachments.map(({ id }) => id),
      ),
      attachmentRetentionStarted
        && !retainedAttachmentsAccepted
        && sourceAttachments.length > 0
        ? dependencies.conversationAttachments.releaseRetention(
            attachmentRetentionId,
          )
        : undefined,
      generated.length > 0
        ? dependencies.generatedAttachments.release(generated)
        : undefined,
    ]);
  };
  messageSendStage = "documents";
  let documentPreparation: PreparedDocumentAttachments;
  let extraction: Promise<PreparedDocumentAttachments> | null = null;
  try {
    const extractionAbort = new AbortController();
    extraction = (
      dependencies.prepareDocumentAttachments
      ?? prepareDocumentAttachments
    )(resolvedAttachments, {
      deadlineAt: preparationDeadlineAt,
      generatedAttachmentStore: dependencies.generatedAttachments,
      signal: extractionAbort.signal,
    });
    documentPreparation = await awaitMessageSendPreparation(
      extraction,
      preparationDeadlineAt,
      () => extractionAbort.abort(),
    );
    generatedAttachmentPaths = documentPreparation.generatedImagePaths;
  } catch (error) {
    void extraction?.then(
      (late) => late.generatedImagePaths.length > 0
        ? dependencies.generatedAttachments.release(late.generatedImagePaths)
        : undefined,
      () => undefined,
    ).catch(() => undefined);
    await relinquishAttachments();
    throw error instanceof DocumentAttachmentError
      ? new RuntimeRequestError(error.message)
      : classifiedMessageSendError(error, "documents");
  }
  messageSendStage = "backend-readiness";
  if (dependencies.enableProviders) {
    try {
      await awaitMessageSendPreparation(
        dependencies.verifyProviderInstallation?.(effectiveProviderId)
          ?? Promise.resolve(),
        preparationDeadlineAt,
      );
    } catch (error) {
      await relinquishAttachments();
      throw classifiedMessageSendError(error, "backend-readiness");
    }
    const selectedProvider = dependencies.providerInfo().find(
      ({ id }) => id === effectiveProviderId,
    );
    try {
      let validatedSelection: ModelSelection;
      try {
        validatedSelection = dependencies.backendProfileController
          .validateSelection(effectiveSelection);
      } catch (error) {
        if (queuedSelectionOverride) {
          throw new QueuedSelectionProviderUnavailableError(
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The selected model backend is unavailable.",
            effectiveProviderId,
            { cause: error },
          );
        }
        throw error;
      }
      const selectedModel = validatedSelection.modelId === "provider-default"
        ? selectedProvider?.models.find(({ isDefault }) => isDefault)
          ?? selectedProvider?.models[0]
        : selectedProvider?.models.find(
            ({ id }) => id === validatedSelection.modelId,
          );
      const externalImageCapability = validatedSelection.capabilities.find(
        ({ id }) => id === "images",
      );
      const supportsScannedPdfImages = dependencies.backendProfileController
        .isExternalSelection(validatedSelection)
        ? externalImageCapability !== undefined
          && externalImageCapability.state !== "unknown"
          && externalImageCapability.state !== "unavailable"
        : selectedModel?.inputModalities.includes("image") === true;
      if (
        documentPreparation.generatedImagePaths.length > 0
        && !supportsScannedPdfImages
      ) {
        throw new RuntimeRequestError(
          "The selected model cannot inspect scanned PDF page images.",
        );
      }
      const backendReadiness = await awaitMessageSendPreparation(
        dependencies.backendProfileController.readiness(
          validatedSelection,
          selectedProvider,
        ),
        preparationDeadlineAt,
      );
      if (backendReadiness && !backendReadiness.ready) {
        const message = backendReadiness.message ?? "The selected model backend is unavailable.";
        throw queuedSelectionOverride
          ? new QueuedSelectionProviderUnavailableError(message, effectiveProviderId)
          : new RuntimeRequestError(message);
      }
      if (!backendReadiness && !selectedProvider?.canRun) {
        const message = selectedProvider?.statusMessage
          ?? "This agent is not ready. Open Settings to finish setup.";
        throw queuedSelectionOverride
          ? new QueuedSelectionProviderUnavailableError(message, effectiveProviderId)
          : new RuntimeRequestError(message);
      }
      // The authoritative selection validator owns native model and
      // reasoning admission; the legacy conversation model fields must
      // never substitute another route here.
    } catch (error) {
      await relinquishAttachments();
      throw error;
    }
  }
  messageSendStage = "skills";
  let resolvedSkills: Awaited<
    ReturnType<AgentWorkflowController["resolveTurnSkills"]>
  >;
  try {
    resolvedSkills = await awaitMessageSendPreparation(
      resolveSkillsForSend(
        dependencies.workflows,
        conversation.id,
        command.payload.content,
        skillConversation,
      ),
      preparationDeadlineAt,
    );
  } catch (error) {
    await relinquishAttachments();
    throw error;
  }
  messageSendStage = "provider-transition";
  let providerTransitionReserved = false;
  try {
    assertMessageSendPreparationPending(preparationDeadlineAt);
    assertTurnSkillsCurrentForSend(
      dependencies.workflows,
      conversation.id,
      resolvedSkills.routeKey,
      skillConversation,
    );
    if (dependencies.enableProviders && !handedOff) {
      const acquisition =
        dependencies.providerTerminalResumes.acquireWhenAvailable(
          conversation.id,
          Math.max(0, preparationDeadlineAt - Date.now()),
        );
      let acquired: boolean;
      try {
        acquired = await awaitMessageSendPreparation(
          acquisition,
          preparationDeadlineAt,
        );
      } catch (error) {
        void acquisition.then((lateAcquired) => {
          if (lateAcquired) {
            dependencies.providerTerminalResumes.release(conversation.id);
          }
        }, () => undefined);
        throw error;
      }
      providerTransitionReserved = acquired;
      assertMessageSendPreparationPending(preparationDeadlineAt);
      if (!acquired) {
        throw new RuntimeRequestError(
          "Wait for this chat's current operation (such as compaction) to finish. If you resumed it in a terminal, close that terminal first.",
        );
      }
      assertTurnSkillsCurrentForSend(
        dependencies.workflows,
        conversation.id,
        resolvedSkills.routeKey,
        skillConversation,
      );
    }
  } catch (error) {
    if (providerTransitionReserved) {
      dependencies.providerTerminalResumes.release(conversation.id);
    }
    await relinquishAttachments();
    throw error;
  }
  messageSendStage = "retention";
  const retentionAbort = new AbortController();
  attachmentRetentionStarted = true;
  const retention = dependencies.conversationAttachments.retain(
    resolvedAttachments,
    retentionAbort.signal,
    attachmentRetentionId,
    () => dependencies.store.evictableAttachmentIds(),
  );
  let retentionCompleted = false;
  try {
    attachments = await awaitMessageSendPreparation(
      retention,
      preparationDeadlineAt,
      () => retentionAbort.abort(),
    );
    retentionCompleted = true;
    const durablePathBySourcePath = new Map(
      sourceAttachments.map((source, index) => [
        source.path,
        attachments[index]?.path ?? source.path,
      ]),
    );
    documentPreparation = {
      ...documentPreparation,
      imagePaths: documentPreparation.imagePaths.map((path) =>
        durablePathBySourcePath.get(path) ?? path),
    };
    assertMessageSendPreparationPending(preparationDeadlineAt);
  } catch (error) {
    if (!retentionCompleted) {
      void retention.then(
        () => dependencies.conversationAttachments
          .releaseRetention(attachmentRetentionId),
        () => undefined,
      ).catch(() => undefined);
    }
    if (providerTransitionReserved) {
      dependencies.providerTerminalResumes.release(conversation.id);
      providerTransitionReserved = false;
    }
    await relinquishAttachments();
    throw error;
  }
  messageSendStage = "turn-persistence";
  let queued: ReturnType<typeof dependencies.turns.queue> | null;
  let durableTurnPersisted = false;
  let deriveInitialTitle = false;
  try {
    scheduledDispatch?.assertCurrent();
    if (dependencies.queuedMessage) {
      assertQueuedClaimCurrent(dependencies, dependencies.store.conversation(conversation.id));
    }
    // A real first-message title can itself equal an untitled placeholder.
    // Capture history before queue/createMessage persists this message.
    deriveInitialTitle = isUntitledConversationTitle(conversation.title)
      && !dependencies.store.hasConversationMessages(conversation.id);
    queued = dependencies.enableProviders
      ? dependencies.turns.queue({
          orchestrationRequest,
          queuedMessageId: dependencies.queuedMessage?.id,
          ...(selectionOverride ? { modelSelectionOverride: selectionOverride } : {}),
          ...(options?.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
          // A queue row that names an unread follow-up starts its turn on that persisted message.
          ...(dependencies.queuedMessage?.userMessageId
            ? { adoptedFollowUp: { messageId: dependencies.queuedMessage.userMessageId } } : {}),
          limitResetPlanId: dependencies.limitResetDispatch?.planId,
          restartContinuationPlanId: dependencies.restartContinuationDispatch?.planId,
          conversationId: conversation.id,
          content: command.payload.content,
          attachments,
          imagePaths: documentPreparation.imagePaths,
          generatedAttachmentPaths,
          documentContexts: documentPreparation.contexts,
          activateConversation: command.payload.activate,
          context: resolvedTurnContext,
          contextRequestId: command.requestId,
          turnCheckpoint: true,
          skills: resolvedSkills.inputs,
          ...(dependencies.watcherDelivery ? { watcherNote: dependencies.watcherDelivery.note, internalInstructions: [dependencies.watcherDelivery.instruction] } : {}),
          ...(dependencies.delegatedDelivery ? { delegatedCompletion: dependencies.delegatedDelivery.attribution,
            internalInstructions: [dependencies.delegatedDelivery.instruction] } : {}),
        }, () => {
          durableTurnPersisted = true;
          acceptRetainedAttachments();
        }, turnAdmission)
      : null;
    if (queued !== null) {
      acceptRetainedAttachments();
    }
  } catch (error) {
    if (durableTurnPersisted) {
      messageSendStage = "turn-publication";
    }
    if (providerTransitionReserved) {
      dependencies.providerTerminalResumes.release(conversation.id);
    }
    await relinquishAttachments();
    if (dependencies.queuedMessage && error instanceof OrchestrationConflict && error.code === "revision-conflict") {
      throw new RuntimeRequestError(
        "The queued message claim was held or superseded before admission.",
        QUEUE_CLAIM_SUPERSEDED_CODE,
      );
    }
    throw error;
  }
  messageSendStage = "turn-publication";
  let attachmentOwnershipAccepted = queued !== null;
  try {
    if (!dependencies.enableProviders) {
      if (generatedAttachmentPaths.length > 0) {
        await dependencies.generatedAttachments.release(generatedAttachmentPaths);
      }
      generatedAttachmentPaths = [];
      if (contextPacketIds.length > 0) {
        dependencies.store.contextPackets.createUserMessageWithPackets({
          conversationId: conversation.id,
          content: command.payload.content,
          attachments,
          packetIds: contextPacketIds,
          requestId: command.requestId,
          options: { activateConversation: command.payload.activate },
        });
      } else {
        dependencies.store.createMessage(
          conversation.id,
          command.payload.content,
          "user",
          attachments,
          null,
          undefined,
          { activateConversation: command.payload.activate },
        );
      }
      acceptRetainedAttachments();
      attachmentOwnershipAccepted = true;
      await dependencies.attachmentResolver?.releaseAll(
        sourceAttachments.map(({ id }) => id),
      );
    }
    const currentTitle = dependencies.store.conversation(conversation.id).title;
    if (deriveInitialTitle && isUntitledConversationTitle(currentTitle)) {
      dependencies.store.updateConversation(conversation.id, {
        title: quickConversationTitle(command.payload.content) || "New chat",
      });
    }
    reply.send(queued
      ? {
          type: "request.result",
          result: {
            kind: "message.accepted",
            conversationId: queued.turn.conversationId,
            turnId: queued.turn.id,
            userMessageId: queued.message.id,
            disposition: "new-turn",
          },
        }
      : {
          // Provider-disabled desktop fixtures persist transcript-only
          // messages and therefore have no authoritative turn to name.
          type: "request.ok",
        });
    if (queued) {
      const queue = dependencies.store.orchestration?.queue;
      if (dependencies.queuedMessage && queue) {
        const v2Item = queue.getItem(dependencies.queuedMessage.id);
        if (v2Item && (v2Item.state === "dispatching" || v2Item.state === "waiting")) {
          const target = dependencies.store.orchestration.runControl.target(queued.turn.runId);
          queue.deliver({
            conversationId: conversation.id,
            itemId: v2Item.id,
            delivery: {
              mode: dependencies.queuedMessage.deliveryMode ?? "run",
              ...(dependencies.queuedMessage.deliveryMode === "after-stop" ? { outcome: "restarted" as const } : {}),
              runId: queued.turn.runId,
              attemptId: target?.attemptId ?? queued.turn.runId,
              turnId: queued.turn.id,
              messageId: queued.message.id,
              deliveredAt: queued.turn.requestedAt,
            },
          });
          dependencies.broadcast({
            type: "conversation.queue.changed",
            conversationId: conversation.id,
            revision: queue.revision(conversation.id),
          });
        }
      } else if (origin === null && queue) {
        const heldItems = queue.listActive(conversation.id)
          .filter((item) => item.queueHeld);
        if (heldItems.length > 0) {
          queue.release({
            conversationId: conversation.id,
            cause: "R1-user-send",
          });
          dependencies.broadcast({
            type: "conversation.queue.changed",
            conversationId: conversation.id,
            revision: queue.revision(conversation.id),
          });
        }
      }
      dependencies.broadcast({
        type: "conversation.message.persisted",
        message: queued.message,
      });
    }
    dependencies.broadcast({
      type: "conversation.detail.invalidated",
      conversationId: conversation.id,
    });
    dependencies.broadcastSnapshot();
    if (queued) dependencies.turns.start(queued.turn.id);
    if (providerTransitionReserved) {
      dependencies.providerTerminalResumes.release(conversation.id);
      providerTransitionReserved = false;
    }
    return;
  } catch (error) {
    if (providerTransitionReserved) {
      dependencies.providerTerminalResumes.release(conversation.id);
      providerTransitionReserved = false;
    }
    if (queued) {
      dependencies.turns.failBeforeStart(
        conversation.id,
        error instanceof Error
          ? error.message
          : "The turn could not start.",
      );
    } else if (!attachmentOwnershipAccepted) {
      await relinquishAttachments();
    }
    throw error;
  }
  } catch (error) {
    throw classifiedMessageSendError(
      error,
      messageSendStage,
    );
  } finally {
    turnAdmission.release();
  }
}
