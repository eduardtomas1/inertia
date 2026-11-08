import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

import type { Conversation, TurnRequestContext } from "../../../shared/contracts";
import type { CommandSource, JsonValue } from "../../orchestration-v2/types";
import { MESSAGE_ADMISSION_UNAVAILABLE, RuntimeRequestError } from "../../runtime-errors";
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
  | { kind: "after-turn" }
  | { kind: "follow-up"; admission: FollowUpAdmissionLease }
  | { kind: "new-turn"; handedOff: boolean; contextPacketIds: readonly string[]; resolvedTurnContext: TurnRequestContext | undefined };

interface NewTurnInput {
  dependencies: TurnInteractionCommandDependencies;
  command: MessageSendCommand;
  conversation: Conversation;
  route: Extract<SendRoute, { kind: "new-turn" }>;
  orchestrationRequest: CommandSource;
  reply: ReplyChannel;
}

export async function sendMessageCommand(
  dependencies: TurnInteractionCommandDependencies,
  socket: WebSocket,
  command: MessageSendCommand,
): Promise<"handled"> {
  if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
  const origin = internalDispatchOrigin(dependencies);
  const orchestrationRequest = messageSendSource(command, origin);
  let messageSendStage: MessageSendStage = "conversation-state";
  let conversation: Conversation;
  try {
    conversation = dependencies.store.conversation(command.payload.conversationId);
  } catch (error) {
    throw classifiedMessageSendError(error, messageSendStage);
  }
  const start = await dependencies.store.orchestration.authority.begin<SendRoute>({
    source: orchestrationRequest, threadId: conversation.id, projectId: conversation.projectId,
    commandType: "message.send", rejection: origin === null ? commandRejection : null,
  }, () => {
    try {
      return routeMessageSend(dependencies, command, conversation, (stage) => { messageSendStage = stage; });
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
      await deliverFollowUpAfterTurn({ dependencies, command, conversation, ticket, reply });
    } else if (route.kind === "follow-up") {
      await sendActiveFollowUp({ dependencies, command, conversation, ticket, reply }, route.admission);
    } else {
      await startNewTurn({ dependencies, command, conversation, route, orchestrationRequest, reply });
    }
  } catch (error) {
    ticket.fail(error);
    throw error;
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
    || !dependencies.store.queuedMessages.routeMatches(dependencies.queuedMessage, conversation)
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
    if (!dependencies.undeliveredFollowUps || (!stopping && !dependencies.turns.followUpArrivedAfterTurn(conversation.id))) {
      throw new RuntimeRequestError(FOLLOW_UP_ROUTE_UNAVAILABLE);
    }
    return { kind: "after-turn" };
  }
  if (dependencies.isolatedRuns.has(conversation.id)) {
    throw new RuntimeRequestError("Wait for the current run or read-only review to finish first.");
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
  const { dependencies, command, orchestrationRequest, reply } = input;
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
  let resolvedAttachments: Awaited<
    ReturnType<TrustedAttachmentResolver["resolvePayloads"]>
  > = [];
  if (dependencies.queuedMessage) {
    const queuedImageLimit = dependencies.enableProviders
      ? providerImageRequestLimitError(conversation.providerId, dependencies.queuedMessage.attachments)
      : null;
    if (queuedImageLimit) throw new RuntimeRequestError(queuedImageLimit);
    for (const attachment of dependencies.queuedMessage.attachments) {
      const preview = await awaitMessageSendPreparation(
        dependencies.conversationAttachments.resolve(attachment.id), preparationDeadlineAt,
      );
      if (!preview) throw new RuntimeRequestError("A queued image is no longer available. Remove this message and attach it again.");
      resolvedAttachments.push({ ...preview, attachment: { ...preview.attachment, ...(attachment.snapshot ? { snapshot: attachment.snapshot } : {}) } });
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
    ? providerImageRequestLimitError(conversation.providerId, sourceAttachments)
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
        dependencies.verifyProviderInstallation?.(conversation.providerId)
          ?? Promise.resolve(),
        preparationDeadlineAt,
      );
    } catch (error) {
      await relinquishAttachments();
      throw classifiedMessageSendError(error, "backend-readiness");
    }
    const selectedProvider = dependencies.providerInfo().find(
      ({ id }) => id === conversation.providerId,
    );
    try {
      const validatedSelection = dependencies.backendProfileController
        .validateSelection(conversation.modelSelection);
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
        throw new RuntimeRequestError(
          backendReadiness.message
            ?? "The selected model backend is unavailable.",
        );
      }
      if (!backendReadiness && !selectedProvider?.canRun) {
        throw new RuntimeRequestError(
          selectedProvider?.statusMessage
            ?? "This agent is not ready. Open Settings to finish setup.",
        );
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
      dependencies.workflows.resolveTurnSkills(
        conversation.id,
        command.payload.content,
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
    dependencies.workflows.assertTurnSkillsCurrent(
      conversation.id,
      resolvedSkills.routeKey,
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
      dependencies.workflows.assertTurnSkillsCurrent(
        conversation.id,
        resolvedSkills.routeKey,
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
      const current = dependencies.store.conversation(conversation.id);
      const item = dependencies.store.queuedMessages.get(conversation.id, dependencies.queuedMessage.id);
      if (current.archivedAt !== null || item?.state !== "dispatching"
        || !dependencies.store.queuedMessages.routeMatches(dependencies.queuedMessage, current)) {
        throw new RuntimeRequestError("The chat changed while its queued message was being prepared.");
      }
    }
    // A real first-message title can itself equal an untitled placeholder.
    // Capture history before queue/createMessage persists this message.
    deriveInitialTitle = isUntitledConversationTitle(conversation.title)
      && !dependencies.store.hasConversationMessages(conversation.id);
    queued = dependencies.enableProviders
      ? dependencies.turns.queue({
          orchestrationRequest,
          queuedMessageId: dependencies.queuedMessage?.id,
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
