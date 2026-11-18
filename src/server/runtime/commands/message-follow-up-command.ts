import { randomUUID } from "node:crypto";

import { chatAttachmentKind } from "../../../shared/attachments";
import type { ChatAttachment, Conversation } from "../../../shared/contracts";
import type { RunSteerOutcome } from "../../../shared/orchestration-run-control";
import type { MessageQueueResult } from "../../../shared/queued-messages";
import type { CommandTicket } from "../../orchestration-v2/command-authority";
import { providerImageRequestLimitError } from "../../provider/provider-image-read";
import { RuntimeRequestError } from "../../runtime-errors";
import type { TrustedAttachmentResolver } from "../attachments/trusted-attachment-resolver";
import type { FollowUpAdmissionLease, FollowUpSteerResult } from "../turns/turn-controller-types";
import { awaitMessageSendPreparation, messageSendPreparationDeadline } from "./message-send-preparation";
import {
  classifiedMessageSendError,
  FOLLOW_UP_ROUTE_UNAVAILABLE,
  type MessageSendCommand,
  type MessageSendStage,
  type ReplyChannel,
} from "./message-send-support";
import type { TurnInteractionCommandDependencies, UndeliveredFollowUp } from "./turn-interaction-types";

interface FollowUpContext {
  dependencies: TurnInteractionCommandDependencies;
  command: MessageSendCommand;
  conversation: Conversation;
  ticket: CommandTicket;
  reply: ReplyChannel;
}

function queuedReceipt(context: FollowUpContext): { disposition: "queued"; queuedMessageId: string } {
  return { disposition: "queued", queuedMessageId: context.command.requestId };
}

export async function deliverFollowUpAfterTurn(context: FollowUpContext): Promise<void> {
  const { dependencies, command, conversation, ticket } = context;
  let recorded = false;
  try {
    const queued = await dependencies.undeliveredFollowUps!.enqueue(
      { conversationId: conversation.id, id: command.requestId, content: command.payload.content,
        attachments: command.payload.attachments },
      command.requestId,
      (insert) => ticket.inLane(() => {
        ticket.commit({ events: [], result: queuedReceipt(context) }, insert);
        recorded = true;
      }),
    );
    if (!recorded) await ticket.inLane(() => ticket.commit({ events: [], result: queuedReceipt(context) }));
    context.reply.send({ type: "request.result", result: queued });
  } catch (error) {
    throw classifiedMessageSendError(error, "follow-up-preparation");
  }
}

export async function sendActiveFollowUp(context: FollowUpContext, admission: FollowUpAdmissionLease): Promise<void> {
  let stage: MessageSendStage = "follow-up-preparation";
  try {
    await steerActiveFollowUp(context, admission, (next) => { stage = next; });
  } catch (error) {
    throw classifiedMessageSendError(error, stage);
  }
}

async function steerActiveFollowUp(
  context: FollowUpContext,
  admission: FollowUpAdmissionLease,
  enterStage: (stage: MessageSendStage) => void,
): Promise<void> {
  const { dependencies, command, conversation, ticket } = context;
  const runControl = dependencies.store.orchestration.runControl;
  const undelivered: Omit<UndeliveredFollowUp, "attachments"> = {
    conversationId: conversation.id,
    id: command.requestId,
    content: command.payload.content,
  };
  const requestedAttachments = command.payload.attachments;
  if (requestedAttachments.length > 0 && !admission.supportsImages) {
    admission.release();
    throw new RuntimeRequestError("The active model cannot inspect follow-up images.");
  }
  const preparationDeadlineAt = messageSendPreparationDeadline();
  let sourceAttachmentIds: string[] = [];
  let retentionId: ReturnType<typeof randomUUID> | null = null;
  let retentionAccepted = false;
  let retentionCompleted = false;
  let retention: Promise<ChatAttachment[]> | null = null;
  let attachments: ChatAttachment[] = [];
  let followUpPersisted = false;
  let providerAcknowledged = false;
  let sourceClaimSettled = false;
  let steerEffectId: string | null = null;
  const settleSteer = (outcome: RunSteerOutcome, refs: { messageId?: string; queuedMessageId?: string } = {}): void => {
    const effectId = steerEffectId;
    steerEffectId = null;
    if (effectId) runControl.settleSteer(effectId, outcome, refs);
  };
  try {
    let resolvedAttachments: Awaited<ReturnType<TrustedAttachmentResolver["resolvePayloads"]>> = [];
    if (requestedAttachments.length > 0) {
      const resolver = dependencies.attachmentResolver;
      if (!resolver) {
        throw new RuntimeRequestError("The selected attachment is no longer available or could not be verified.");
      }
      const resolutionAbort = new AbortController();
      resolvedAttachments = await awaitMessageSendPreparation(
        resolver.resolvePayloads(requestedAttachments, command.requestId, resolutionAbort.signal),
        preparationDeadlineAt,
        () => resolutionAbort.abort(),
      );
      if (resolvedAttachments.some(({ attachment }) => chatAttachmentKind(attachment.mimeType) !== "image")) {
        sourceAttachmentIds = resolvedAttachments.map(({ attachment }) => attachment.id);
        throw new RuntimeRequestError("Follow-ups while the agent is working support images only.");
      }
      sourceAttachmentIds = resolvedAttachments.map(({ attachment }) => attachment.id);
      const imageLimit = providerImageRequestLimitError(
        conversation.providerId,
        resolvedAttachments.map(({ attachment }) => attachment),
      );
      if (imageLimit) throw new RuntimeRequestError(imageLimit);
    }
    attachments = resolvedAttachments.map(({ attachment }) => attachment);
    if (resolvedAttachments.length > 0) {
      retentionId = randomUUID();
      const retentionAbort = new AbortController();
      retention = dependencies.conversationAttachments.retain(
        resolvedAttachments,
        retentionAbort.signal,
        retentionId,
        () => dependencies.store.evictableAttachmentIds(),
      );
      attachments = await awaitMessageSendPreparation(retention, preparationDeadlineAt, () => retentionAbort.abort());
      retentionCompleted = true;
    }
    const steerRequest = await ticket.inLane(() => runControl.requestSteer(ticket, admission.runId, admission.turnId));
    if (steerRequest.kind === "requested") steerEffectId = steerRequest.effectId;
    const steered: FollowUpSteerResult = steerRequest.kind === "closed"
      ? { kind: "turn-ended" }
      : await dependencies.turns.steer(
        admission,
        { content: command.payload.content, imagePaths: attachments.map(({ path }) => path) },
        attachments,
        () => {
          providerAcknowledged = true;
          enterStage("follow-up-publication");
          if (!retentionId) return;
          dependencies.conversationAttachments.acceptRetention(retentionId);
          retentionAccepted = true;
        },
        AbortSignal.timeout(Math.max(0, preparationDeadlineAt - Date.now())),
      );
    if ((steered.kind === "turn-ended" || steered.kind === "refused" || steered.kind === "unconfirmed") && dependencies.undeliveredFollowUps) {
      let queued: MessageQueueResult | null = null;
      const adopt = () => {
        queued = dependencies.undeliveredFollowUps!.adopt(
          { ...undelivered, attachments },
          steered.kind === "unconfirmed" ? steered.message : null,
        );
      };
      try {
        adopt();
        if (steerRequest.kind !== "requested") await ticket.inLane(() => ticket.commit({ events: [], result: queuedReceipt(context) }));
      } catch (error) {
        if (steered.kind !== "unconfirmed") throw error;
        settleSteer("unconfirmed");
        throw new RuntimeRequestError(steered.message, undefined, "ambiguous");
      }
      settleSteer(steered.kind, { queuedMessageId: command.requestId });
      followUpPersisted = true;
      if (retentionId && !retentionAccepted) {
        dependencies.conversationAttachments.acceptRetention(retentionId);
        retentionAccepted = true;
      }
      await dependencies.attachmentResolver?.releaseAll(sourceAttachmentIds);
      sourceClaimSettled = true;
      context.reply.send({ type: "request.result", result: queued! });
      return;
    }
    if (steered.kind === "unconfirmed") {
      settleSteer("unconfirmed");
      throw new RuntimeRequestError(steered.message, undefined, "ambiguous");
    }
    const followUpMessage = steered.kind === "accepted" ? steered.message : null;
    if (!followUpMessage?.turnId) {
      settleSteer(steered.kind === "accepted" ? "unavailable" : steered.kind);
      throw new RuntimeRequestError(FOLLOW_UP_ROUTE_UNAVAILABLE);
    }
    settleSteer("accepted", { messageId: followUpMessage.id });
    followUpPersisted = true;
    enterStage("follow-up-publication");
    await dependencies.attachmentResolver?.releaseAll(sourceAttachmentIds);
    sourceClaimSettled = true;
    context.reply.send({
      type: "request.result",
      result: {
        kind: "message.accepted",
        conversationId: followUpMessage.conversationId,
        turnId: followUpMessage.turnId,
        userMessageId: followUpMessage.id,
        disposition: "follow-up",
      },
    });
    dependencies.broadcast({ type: "conversation.message.persisted", message: followUpMessage });
    dependencies.broadcastSnapshot();
  } catch (error) {
    settleSteer(providerAcknowledged ? "unconfirmed" : "unavailable");
    const deferRetentionCleanup = providerAcknowledged && !followUpPersisted && retentionId !== null;
    if (deferRetentionCleanup) {
      const exactRetentionId = retentionId!;
      dependencies.turns.deferFollowUpAttachmentCleanup(admission, async () => {
        if (retentionAccepted) await dependencies.conversationAttachments.release(attachments.map(({ id }) => id));
        else await dependencies.conversationAttachments.releaseRetention(exactRetentionId);
      });
    }
    if (retentionId && !retentionAccepted && !deferRetentionCleanup) {
      const exactRetentionId = retentionId;
      if (retention && !retentionCompleted) {
        void retention.then(
          () => dependencies.conversationAttachments.releaseRetention(exactRetentionId),
          () => undefined,
        ).catch(() => undefined);
      } else {
        await dependencies.conversationAttachments.releaseRetention(exactRetentionId).catch(() => undefined);
      }
    }
    if (retentionAccepted) {
      await Promise.all([
        followUpPersisted || deferRetentionCleanup
          ? undefined
          : dependencies.conversationAttachments.release(attachments.map(({ id }) => id)),
        sourceClaimSettled ? undefined : dependencies.attachmentResolver?.releaseAll(sourceAttachmentIds),
      ]);
    } else if (!sourceClaimSettled) {
      if (providerAcknowledged) await dependencies.attachmentResolver?.releaseAll(sourceAttachmentIds);
      else await dependencies.attachmentResolver?.relinquishAll(sourceAttachmentIds);
    }
    throw error;
  } finally {
    admission.release();
  }
}
