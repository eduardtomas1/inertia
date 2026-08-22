import {
  isAgentTurnTerminalStatus,
  type AgentTurnTerminalStatus,
  type Conversation,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type {
  ProviderRunFailure,
} from "../../provider/contracts";
import type { TurnActivityProjection } from "./turn-activity-projection";
import type { TurnArtifactSequencer } from "./turn-artifact-sequencer";
import type { TurnStreamProjection } from "./turn-stream-projection";
import { publicTurnError } from "./turn-controller-support";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTerminalCause,
  TurnTimerScheduler,
} from "./turn-controller-types";

export interface TurnSettlementCoordinatorOptions {
  store: RuntimeStore;
  hooks: TurnControllerHooks;
  scheduler: TurnTimerScheduler;
  activities: TurnActivityProjection;
  artifacts: TurnArtifactSequencer;
  streams: TurnStreamProjection;
  now(): string;
  cleanup(active: ActiveTurn): void;
  track(value: void | Promise<void> | undefined): void;
}

/**
 * Performs the synchronous authoritative terminal transition before starting
 * any optional artifact or metadata work.
 */
export class TurnSettlementCoordinator {
  constructor(private readonly options: TurnSettlementCoordinatorOptions) {}

  settle(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    cause: TurnTerminalCause,
    message?: string,
    failure?: ProviderRunFailure,
  ): boolean {
    const authoritativeStatus = active.runState.settle(status);
    if (!authoritativeStatus) return false;
    status = authoritativeStatus;
    if (active.timeoutTimer !== null) {
      this.options.scheduler.clearTimeout(active.timeoutTimer);
      active.timeoutTimer = null;
    }
    if (active.lifetimeTimer !== null) {
      this.options.scheduler.clearTimeout(active.lifetimeTimer);
      active.lifetimeTimer = null;
    }

    let persistenceError: string | null = null;
    const notePersistenceError = (error: unknown): void => {
      const detail = publicTurnError(error);
      persistenceError = persistenceError
        ? `${persistenceError}; ${detail}`
        : detail;
    };
    try {
      this.options.streams.flush(active, "assistant");
    } catch (error) {
      notePersistenceError(error);
    }
    try {
      this.options.streams.flush(active, "reasoning");
    } catch (error) {
      notePersistenceError(error);
    }
    try {
      const completed = status === "completed";
      this.options.activities.settleRunning(
        active,
        completed ? "completed" : "failed",
        completed
          ? undefined
          : status === "cancelled"
            ? message ?? "The turn was stopped."
            : failure && failure.reason !== "codex-error"
              ? failure.message
              : message ?? "The turn did not complete.",
        status === "cancelled" ? "cancelled" : undefined,
      );
    } catch (error) {
      notePersistenceError(error);
    }
    try {
      const subagentStatus = status === "cancelled" ? "cancelled" : "lost";
      for (const trace of this.options.store.settleLiveSubagents(
        active.turn.id,
        subagentStatus,
        this.options.now(),
      )) {
        this.options.hooks.broadcast({
          type: "agent.subagent.updated",
          trace,
        });
      }
    } catch (error) {
      notePersistenceError(error);
    }
    if (active.reasoningId) {
      try {
        this.options.store.updateReasoning(active.reasoningId, {
          content: active.reasoningText,
          status: status === "completed" ? "completed" : "failed",
        });
      } catch (error) {
        notePersistenceError(error);
      }
    }

    const terminalReason = persistenceError
      ? `${cause}: ${persistenceError}`.slice(0, 4_000)
      : cause;
    return this.finalizeGuarded(
      active,
      status,
      terminalReason,
      message,
      failure,
    );
  }

  private finalizeGuarded(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    terminalReason: string,
    message?: string,
    failure?: ProviderRunFailure,
  ): boolean {
    try {
      return this.finalize(
        active,
        status,
        terminalReason,
        message,
        failure,
      );
    } catch {
      try {
        active.runState.repairSettlementFailure("stream-persistence-failed");
        const latest = this.options.store.agentTurn(active.turn.id);
        const repairedAt = this.options.now();
        active.turn = isAgentTurnTerminalStatus(latest.status)
          ? latest
          : this.options.store.settleAgentTurn(active.turn.id, {
              status: "failed",
              runState: active.runState.snapshot(),
              terminalAssistantMessageId: active.latestAssistantMessageId,
              providerSessionAfter: active.sessionAfter,
              terminalReason: "stream-persistence-failed",
              checkpointId: active.checkpointId,
              usageAtCompletion: active.lastUsage,
              startedAt: latest.startedAt ?? repairedAt,
              completedAt: repairedAt,
              updatedAt: repairedAt,
            }).turn;
      } catch {
        // Runtime recovery repairs any lifecycle row that could not settle.
      }
      this.options.cleanup(active);
      try {
        this.options.store.updateConversation(active.conversation.id, {
          status: "failed",
          attentionKind: null,
        });
        if (active.workspaceRunCreated) {
          this.options.store.updateWorkspaceRun(active.turn.runId, {
            status: "failed",
            detail: "The turn could not be finalized cleanly.",
          });
        }
      } catch {
        // Workspace activity is a repairable projection.
      }
      try {
        this.options.hooks.broadcast({
          type: "agent.failed",
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          status: "failed",
          terminalReason: "stream-persistence-failed",
          message: "The turn could not be finalized cleanly.",
        });
        this.options.hooks.broadcast({
          type: "conversation.detail.invalidated",
          conversationId: active.conversation.id,
        });
        this.options.hooks.broadcastSnapshot();
      } catch {
        // A renderer connection must not keep the controller wedged.
      }
      return false;
    }
  }

  private finalize(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    terminalReason: string,
    message?: string,
    failure?: ProviderRunFailure,
  ): boolean {
    const completedAt = this.options.now();
    const settlement = this.options.store.settleAgentTurn(active.turn.id, {
      status,
      runState: active.runState.snapshot(),
      terminalAssistantMessageId: active.latestAssistantMessageId,
      providerSessionAfter: active.sessionAfter,
      terminalReason,
      checkpointId: active.checkpointId,
      usageAtCompletion: active.lastUsage,
      // A queued turn may fail after command acceptance but before start().
      // Give that direct terminal transition one coherent lifecycle boundary.
      startedAt: active.turn.startedAt ?? completedAt,
      completedAt,
      updatedAt: completedAt,
    });
    active.turn = settlement.turn;
    this.options.hooks.testOnlyStreamingTrace?.mark("terminal-persistence-completed");
    this.options.cleanup(active);
    if (!settlement.settled) return false;

    const projectedStatus: Conversation["status"] = status === "completed"
      ? "completed"
      : status === "cancelled"
        ? "idle"
        : "failed";
    try {
      if (
        active.sessionAfter
        && active.sessionAfter !== active.conversation.providerSessionId
      ) {
        this.options.store.updateConversation(active.conversation.id, {
          providerSessionId: active.sessionAfter,
          continuationIdentity: active.turn.continuationIdentity,
        });
      }
      this.options.store.updateConversation(active.conversation.id, {
        status: projectedStatus,
        attentionKind: null,
      });
      if (active.workspaceRunCreated) {
        this.options.store.updateWorkspaceRun(active.turn.runId, {
          status: status === "completed"
            ? "succeeded"
            : status === "cancelled"
              ? "cancelled"
              : "failed",
          detail: message ?? active.conversation.title,
        });
      }
    } catch {
      // Projections are repairable; agent_turns remains lifecycle truth.
    }
    if (status === "failed" || status === "interrupted") {
      const failureMessage = message ?? (
        status === "interrupted"
          ? "The agent turn was interrupted."
          : "The provider could not complete the request."
      );
      try {
        const activity = this.options.store.addActivity({
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          kind: "error",
          title: failureMessage,
          detail: failure?.technicalDetail ?? null,
          status: "failed",
        });
        this.options.hooks.broadcast({ type: "agent.activity", activity });
      } catch {
        // A failed error projection cannot replace the authoritative outcome.
      }
      this.options.hooks.broadcast({
        type: "agent.failed",
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        status,
        terminalReason,
        message: failureMessage,
      });
    } else {
      this.options.hooks.broadcast({
        type: "agent.completed",
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        status,
        terminalReason,
      });
    }
    this.options.hooks.testOnlyStreamingTrace?.mark("terminal-event-projected");
    this.options.hooks.broadcast({
      type: "conversation.detail.invalidated",
      conversationId: active.conversation.id,
    });
    this.options.hooks.broadcastSnapshot();

    // Optional repository materialization is deliberately downstream of the
    // terminal event and snapshot so Stop disappears immediately.
    this.options.artifacts.finalize(active);
    this.options.track(this.options.hooks.refreshProviderMetadata?.({
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      turnId: active.turn.id,
      runStartedAt: active.runStartedAt,
      status,
    }));
    this.options.track(this.options.hooks.onTurnSettled?.(active.turn));
    this.options.track(active.onSettled?.(status, active.turn.id));
    return true;
  }
}
