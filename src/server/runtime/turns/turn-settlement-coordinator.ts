import {
  isAgentTurnTerminalStatus,
  type AgentTurnTerminalStatus,
  type ChatMessage,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type {
  ProviderRunFailure,
} from "../../provider/contracts";
import type { TurnActivityProjection } from "./turn-activity-projection";
import type { TurnArtifactSequencer } from "./turn-artifact-sequencer";
import type { TurnStreamProjection } from "./turn-stream-projection";
import { TurnStreamPersistenceError } from "./turn-stream-channel";
import { TurnSettlementEffects } from "./turn-settlement-effects";
import { publicTurnError } from "./turn-controller-support";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnTerminalCause,
  TurnTimerScheduler,
} from "./turn-controller-types";

type CommittedSettlement = ReturnType<RuntimeStore["settleAgentTurn"]> & {
  receiptLost?: true;
};

export interface TurnSettlementCoordinatorOptions {
  store: RuntimeStore;
  hooks: TurnControllerHooks;
  scheduler: TurnTimerScheduler;
  activities: TurnActivityProjection;
  artifacts: TurnArtifactSequencer;
  streams: TurnStreamProjection;
  now(): string;
  cleanup(active: ActiveTurn): void;
  track(value: void | Promise<void> | undefined, onSettled: () => void): void;
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
    let streamPersistenceFailed = false;
    let streamPublicationFailed = false;
    const notePersistenceError = (error: unknown): void => {
      const detail = publicTurnError(error);
      persistenceError = persistenceError
        ? `${persistenceError}; ${detail}`
        : detail;
    };
    for (const channel of ["assistant", "reasoning"] as const) {
      try {
        this.options.streams.flush(active, channel);
      } catch (error) {
        if (error instanceof TurnStreamPersistenceError) {
          streamPersistenceFailed = true;
          notePersistenceError(error);
        } else {
          streamPublicationFailed = true;
        }
      }
    }
    if (streamPersistenceFailed) {
      active.runState.repairSettlementFailure("stream-persistence-failed");
      status = "failed";
      cause = "stream-persistence-failed";
      message = "The response could not be saved completely.";
      failure = undefined;
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
      streamPublicationFailed,
    );
  }

  private finalizeGuarded(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    terminalReason: string,
    message?: string,
    failure?: ProviderRunFailure,
    streamPublicationFailed = false,
  ): boolean {
    let settlement: CommittedSettlement;
    try {
      settlement = this.commit(active, status, terminalReason, message);
    } catch {
      try {
        active.runState.repairSettlementFailure("stream-persistence-failed");
        message = "The turn could not be finalized cleanly.";
        settlement = this.commit(active, "failed", "stream-persistence-failed", message);
        failure = undefined;
      } catch {
        // Retain the active owner: failed persistence is not permission to
        // admit another writer. Startup recovery owns the nonterminal row.
        this.effects(active).failed("terminal-persistence");
        return false;
      }
    }
    active.turn = settlement.turn;
    if (!isAgentTurnTerminalStatus(active.turn.status)) return false;
    active.runState.acknowledgeTerminalCommit(active.turn);
    const effects = this.effects(active);
    if (streamPublicationFailed) effects.failed("publication");
    if (settlement.receiptLost) effects.failed("orchestration");
    effects.run("publication", () => this.options.hooks.testOnlyStreamingTrace
      ?.mark("terminal-persistence-completed"));
    const cleaned = effects.run("lifecycle-cleanup", () => this.options.cleanup(active));
    this.finalize(active, effects, settlement.settled, cleaned, message, failure);
    return settlement.settled;
  }

  private effects(active: ActiveTurn): TurnSettlementEffects {
    return new TurnSettlementEffects({
      store: this.options.store,
      turn: active.turn,
      hooks: this.options.hooks,
      track: this.options.track,
    });
  }

  private commit(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    terminalReason: string,
    message?: string,
  ): CommittedSettlement {
    const completedAt = this.options.now();
    try {
      return this.options.store.settleAgentTurn(active.turn.id, {
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
        projection: {
          workspaceRunCreated: active.workspaceRunCreated,
          detail: message ?? active.conversation.title,
        },
      });
    } catch (error) {
      // Both the initial write and a failed-write repair can commit before
      // their caller observes an exception. Never reinterpret that saved row.
      const latest = this.options.store.agentTurn(active.turn.id);
      if (!isAgentTurnTerminalStatus(latest.status)) throw error;
      return { settled: false, turn: latest, receiptLost: true };
    }
  }

  private finalize(
    active: ActiveTurn,
    effects: TurnSettlementEffects,
    wonSettlement: boolean,
    cleaned: boolean,
    message?: string,
    failure?: ProviderRunFailure,
  ): void {
    const status = active.turn.status as AgentTurnTerminalStatus;
    const terminalReason = active.turn.terminalReason ?? "provider-completed";
    let terminalAssistantMessage: ChatMessage | null = null;
    effects.run("projection", () => {
      terminalAssistantMessage = active.turn.terminalAssistantMessageId
        ? this.options.store.message(active.turn.terminalAssistantMessageId)
        : null;
    });
    if (wonSettlement && (status === "failed" || status === "interrupted")) {
      const failureMessage = message ?? (
        status === "interrupted"
          ? "The agent turn was interrupted."
          : "The provider could not complete the request."
      );
      effects.run("projection", () => {
        const activity = this.options.store.addActivity({
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          kind: "error",
          title: failureMessage,
          detail: failure?.technicalDetail ?? null,
          status: "failed",
        });
        effects.run("publication", () => this.options.hooks.broadcast({ type: "agent.activity", activity }));
      });
      effects.run("publication", () => this.options.hooks.broadcast({
        type: "agent.failed",
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        status,
        terminalReason,
        message: failureMessage,
        terminalAssistantMessageId: active.turn.terminalAssistantMessageId,
        terminalAssistantMessage,
      }));
    } else if (wonSettlement && (status === "completed" || status === "cancelled")) {
      effects.run("publication", () => this.options.hooks.broadcast({
        type: "agent.completed",
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        status,
        terminalReason,
        terminalAssistantMessageId: active.turn.terminalAssistantMessageId,
        terminalAssistantMessage,
      }));
    }
    effects.run("publication", () => this.options.hooks.testOnlyStreamingTrace?.mark("terminal-event-projected"));
    effects.run("publication", () => this.options.hooks.broadcast({
      type: "conversation.detail.invalidated",
      conversationId: active.conversation.id,
    }));
    effects.run("publication", () => this.options.hooks.broadcastSnapshot());

    if (!cleaned) {
      // Durable orchestration remains recoverable, but it must not launch new
      // work while the exact turn's mandatory local cleanup is incomplete.
      effects.failed("orchestration");
      return;
    }
    if (!wonSettlement) return;

    // Optional repository materialization is deliberately downstream of the
    // terminal event and snapshot so Stop disappears immediately.
    effects.run("artifacts", () => this.options.artifacts.finalize(active, effects));
    effects.run("metadata", () => this.options.hooks.refreshProviderMetadata?.({
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      turnId: active.turn.id,
      runStartedAt: active.runStartedAt,
      status,
    }));
    effects.run("orchestration", () => this.options.hooks.onTurnSettled?.(active.turn));
    effects.run("turn-follow-up", () => active.onSettled?.(status, active.turn.id));
  }
}
