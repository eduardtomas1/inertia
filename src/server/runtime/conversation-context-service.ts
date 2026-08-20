import type {
  ConversationContextPacket,
  ConversationContextSourceTranscript,
  MaterializedConversationContext,
} from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { ConversationContextReplay } from "../persistence/conversation-context-packet-repository";
import type {
  ConversationContextAuthorizationScope,
  ConversationContextSelection,
} from "./conversation-context-request-coordinator";

export interface ConversationContextPacketCreationRequest {
  sourceConversationId: string;
  targetConversationId: string;
  sourceMessageIds: readonly string[];
  note?: string;
  acknowledgedWorkspaceDifference: boolean;
}

export interface ConversationContextAuthorizationVerifier {
  /**
   * The host owns the receipt and its verification. Implementations should use
   * one-shot process-local objects (for example a WeakSet), never IPC strings.
   */
  consume(
    receipt: unknown,
    scope: ConversationContextAuthorizationScope,
  ): ConversationContextSelection | null;
}

/**
 * Narrow server-only boundary for a future agent-facing thread tool. The host
 * must inject a verifier for its exact one-shot approval receipt. JSON/IPC
 * values (including confirmation IDs) are deliberately not authority.
 */
export function createConversationContextPacketFromAuthorizedAgent(
  store: RuntimeStore,
  request: ConversationContextAuthorizationScope & {
    authorizationReceipt: unknown;
    targetUserMessageId: string;
    completedAt: string;
  },
  verifier: ConversationContextAuthorizationVerifier,
): { packet: ConversationContextPacket; resultJson: string } {
  const selection = verifier.consume(request.authorizationReceipt, {
    contextRequestId: request.contextRequestId,
    targetConversationId: request.targetConversationId,
    targetTurnId: request.targetTurnId,
    targetRunId: request.targetRunId,
    toolCallIdHash: request.toolCallIdHash,
  });
  if (!selection) {
    throw new Error("Agent-requested chat context requires explicit user confirmation.");
  }
  return store.contextPackets.completeAgentRequest({
    requestId: request.contextRequestId,
    targetTurnId: request.targetTurnId,
    targetRunId: request.targetRunId,
    targetUserMessageId: request.targetUserMessageId,
    toolCallIdHash: request.toolCallIdHash,
    completedAt: request.completedAt,
    sourceConversationId: selection.sourceConversationId,
    targetConversationId: request.targetConversationId,
    sourceMessageIds: selection.sourceMessageIds,
    note: selection.note,
    acknowledgedWorkspaceDifference: selection.acknowledgedWorkspaceDifference,
  });
}

export class ConversationContextService {
  constructor(private readonly store: RuntimeStore) {}

  createFromRenderer(
    request: ConversationContextPacketCreationRequest,
  ): ConversationContextPacket {
    return this.store.contextPackets.create({
      sourceConversationId: request.sourceConversationId,
      targetConversationId: request.targetConversationId,
      sourceMessageIds: request.sourceMessageIds,
      note: request.note,
      acknowledgedWorkspaceDifference: request.acknowledgedWorkspaceDifference,
    });
  }

  sourceTranscript(
    sourceConversationId: string,
    targetConversationId: string,
  ): ConversationContextSourceTranscript {
    return this.store.contextPackets.sourceTranscript(
      sourceConversationId,
      targetConversationId,
    );
  }

  load(
    packetId: string,
    targetConversationId: string,
  ): ConversationContextPacket {
    return this.store.contextPackets.get(packetId, targetConversationId);
  }

  remove(packetId: string, targetConversationId: string): void {
    this.store.contextPackets.deleteDraft(packetId, targetConversationId);
  }

  materializeForTurn(
    targetConversationId: string,
    packetIds: readonly string[],
  ): MaterializedConversationContext[] {
    return this.store.contextPackets.materialize(
      targetConversationId,
      packetIds,
    );
  }

  replayAcceptance(
    requestId: string,
    targetConversationId: string,
    packetIds: readonly string[],
  ): ConversationContextReplay | null {
    return this.store.contextPackets.replayAcceptance(
      requestId,
      targetConversationId,
      packetIds,
    );
  }
}
