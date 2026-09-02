import type { AgentPlan } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import { publicTurnError } from "./turn-controller-support";
import type {
  ActiveTurn,
  QueuedTurn,
  TurnControllerHooks,
} from "./turn-controller-types";
import type { PreparedTurnRequest } from "./turn-request-preparation";
import type { TurnStreamProjection } from "./turn-stream-projection";
import type { TurnStreamChannel } from "./turn-stream-channel";

interface LiveTurnAdoptionOptions {
  store: RuntimeStore;
  streams: TurnStreamProjection;
  hooks: TurnControllerHooks;
  activeByConversation: Map<string, ActiveTurn>;
  activeByTurn: Map<string, ActiveTurn>;
  agentPlans: Map<string, AgentPlan>;
  failActive(active: ActiveTurn, message: string): boolean;
  failQueued(queued: QueuedTurn, checkpointId: string | null): void;
  cleanup(active: ActiveTurn): void;
  track(value: void | Promise<void> | undefined): void;
}

/**
 * Attaches the in-memory resources for a durable queued turn. Any synchronous
 * failure leaves the persisted turn terminal and removes every partial live
 * owner before the error returns to the command boundary.
 */
export function adoptLiveTurn(
  options: LiveTurnAdoptionOptions,
  prepared: PreparedTurnRequest,
): QueuedTurn {
  const { queued } = prepared;
  let active: ActiveTurn | undefined;
  let assistantStream: TurnStreamChannel | undefined;
  let reasoningStream: TurnStreamChannel | undefined;
  try {
    assistantStream = options.streams.create(() => {
      if (!active) throw new Error("Assistant stream owner is unavailable.");
      return active;
    }, "assistant");
    reasoningStream = options.streams.create(() => {
      if (!active) throw new Error("Reasoning stream owner is unavailable.");
      return active;
    }, "reasoning");
    active = {
      ...prepared.active,
      assistantStream,
      reasoningStream,
    };
    options.activeByConversation.set(active.conversation.id, active);
    options.activeByTurn.set(queued.turn.id, active);
    options.agentPlans.delete(active.conversation.id);

    if (active.checkpointId) {
      options.store.associateCheckpointWithTurn(
        active.checkpointId,
        active.conversation.id,
        active.turn.runId,
        active.turn.id,
      );
    }
    if (active.structuredContext !== undefined) {
      options.track(options.hooks.onStructuredContextCaptured?.({
        turn: queued.turn,
        context: active.structuredContext,
      }));
    }
    return queued;
  } catch (error) {
    if (active) {
      try {
        if (!options.failActive(active, publicTurnError(error))) {
          options.cleanup(active);
          options.failQueued(queued, active.checkpointId);
        }
      } catch {
        options.cleanup(active);
        options.failQueued(queued, active.checkpointId);
      }
    } else {
      assistantStream?.dispose();
      reasoningStream?.dispose();
      options.failQueued(queued, prepared.active.checkpointId);
    }
    throw error;
  }
}

/** Best-effort terminal repair for failures before a live ActiveTurn exists. */
export function settleQueuedAdoptionFailure(
  store: RuntimeStore,
  queued: QueuedTurn,
  now: string,
  checkpointId: string | null,
): void {
  try {
    const retainedCheckpointId = checkpointId;
    if (checkpointId) {
      try {
        store.associateCheckpointWithTurn(
          checkpointId,
          queued.turn.conversationId,
          queued.turn.runId,
          queued.turn.id,
        );
      } catch {
        // Retain the exact checkpoint/ref for recovery even when association
        // itself is the failing adoption boundary.
      }
    }
    store.settleAgentTurn(queued.turn.id, {
      status: "failed",
      terminalReason: "turn-adoption-failed",
      checkpointId: retainedCheckpointId,
      startedAt: queued.turn.startedAt ?? now,
      completedAt: now,
      updatedAt: now,
    });
    store.updateConversation(queued.turn.conversationId, {
      status: "failed",
      attentionKind: null,
    });
  } catch {
    // Startup recovery repairs an exceptionally unavailable durable ledger.
  }
}
