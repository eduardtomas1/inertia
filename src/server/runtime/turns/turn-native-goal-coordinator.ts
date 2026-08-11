import type { AgentGoalStatus } from "../../../shared/contracts";
import type {
  ProviderEvent,
  ProviderGoalSnapshot,
} from "../../provider/contracts";
import type { RuntimeStore } from "../../database";
import type {
  ActiveTurn,
  QueuedTurn,
  QueueTurnRequest,
  TurnControllerHooks,
  TurnProviderRuntime,
} from "./turn-controller-types";

interface TurnNativeGoalCoordinatorOptions {
  store: RuntimeStore;
  providers: TurnProviderRuntime;
  hooks: TurnControllerHooks;
  activeForConversation: (conversationId: string) => ActiveTurn | undefined;
  activeForTurn: (turnId: string) => ActiveTurn | undefined;
  queue: (request: QueueTurnRequest) => QueuedTurn;
  start: (turnId: string) => boolean;
}

export class TurnNativeGoalCoordinator {
  constructor(private readonly options: TurnNativeGoalCoordinatorOptions) {}

  async set(input: {
    conversationId: string;
    objective?: string;
    status: AgentGoalStatus;
    tokenBudget?: number | null;
  }): Promise<ProviderGoalSnapshot | null> {
    const active = this.options.activeForConversation(input.conversationId);
    if (active && !active.settled) {
      if (!this.options.providers.setGoal) {
        throw new Error("The active provider cannot update native goals.");
      }
      const updated = await this.options.providers.setGoal(
        input.conversationId,
        {
          ...(input.objective !== undefined
            ? { objective: input.objective }
            : {}),
          status: input.status,
          ...(input.tokenBudget !== undefined
            ? { tokenBudget: input.tokenBudget }
            : {}),
        },
        { runId: active.turn.runId, turnId: active.turn.id },
      );
      if (!updated) {
        throw new Error("The active Codex run no longer owns this goal.");
      }
      return updated;
    }
    if (input.status !== "active") return null;

    const savedGoal = this.options.store.agentGoals(input.conversationId)
      .find(({ source }) => source === "codex-native");
    const visibleObjective = input.objective?.trim() || savedGoal?.objective;
    if (!visibleObjective) {
      throw new Error("Define an objective before starting a Codex goal.");
    }
    const queued = this.options.queue({
      conversationId: input.conversationId,
      content: `/goal ${visibleObjective}`,
      goalStart: {
        ...(input.objective !== undefined
          ? { objective: input.objective }
          : {}),
        ...(input.tokenBudget !== undefined
          ? { tokenBudget: input.tokenBudget }
          : {}),
      },
    });
    const goal = new Promise<ProviderGoalSnapshot>((resolve, reject) => {
      const owned = this.options.activeForTurn(queued.turn.id);
      if (!owned || owned.settled) {
        reject(new Error("The Codex goal run could not be prepared."));
        return;
      }
      owned.nativeGoalStartAcknowledgement = {
        ...(input.objective !== undefined
          ? { objective: input.objective }
          : {}),
        ...(input.tokenBudget !== undefined
          ? { tokenBudget: input.tokenBudget }
          : {}),
        latestGoal: null,
        cleared: false,
        settlementQueued: false,
        resolve,
        reject,
      };
    });
    this.options.hooks.broadcast({
      type: "conversation.detail.invalidated",
      conversationId: input.conversationId,
    });
    this.options.hooks.broadcastSnapshot();
    if (!this.options.start(queued.turn.id)) {
      const owned = this.options.activeForTurn(queued.turn.id);
      const acknowledgement = owned?.nativeGoalStartAcknowledgement;
      if (owned) owned.nativeGoalStartAcknowledgement = null;
      acknowledgement?.reject(
        new Error("The Codex goal run could not start."),
      );
    }
    return await goal;
  }

  async clear(
    conversationId: string,
  ): Promise<boolean | "superseded" | null> {
    const active = this.options.activeForConversation(conversationId);
    if (!active || active.settled) return null;
    if (!this.options.providers.clearGoal) {
      throw new Error("The active provider cannot clear native goals.");
    }
    return await this.options.providers.clearGoal(
      conversationId,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
  }

  handleEvent(active: ActiveTurn, event: ProviderEvent): void {
    const goalStart = active.nativeGoalStartAcknowledgement;
    if (
      goalStart
      && event.type === "goal-updated"
      && this.matchesSession(active, event)
      && (goalStart.objective === undefined
        || event.goal.objective === goalStart.objective)
      && (goalStart.tokenBudget === undefined
        || event.goal.tokenBudget === goalStart.tokenBudget)
    ) {
      goalStart.latestGoal = event.goal;
      goalStart.cleared = false;
      this.queueSettlement(active, goalStart);
    } else if (
      goalStart
      && event.type === "goal-cleared"
      && this.matchesSession(active, event)
    ) {
      goalStart.latestGoal = null;
      goalStart.cleared = true;
      // A clear received before the goal-set response is an older tombstone
      // when that response later confirms a recreation. A queued update or
      // provider cleanup remains responsible for settling the acknowledgement.
    }
  }

  cleanup(active: ActiveTurn): void {
    const goalStart = active.nativeGoalStartAcknowledgement;
    active.nativeGoalStartAcknowledgement = null;
    goalStart?.reject(
      new Error("The Codex goal run ended before the goal was confirmed."),
    );
  }

  private matchesSession(
    active: ActiveTurn,
    event: Extract<ProviderEvent, {
      type: "goal-updated" | "goal-cleared";
    }>,
  ): boolean {
    const expectedSessionId = active.sessionAfter
      ?? active.providerInput.sessionId
      ?? active.conversation.providerSessionId;
    return event.providerId === "codex"
      && active.turn.harnessId === "codex-app-server"
      && Boolean(expectedSessionId)
      && event.sessionId === expectedSessionId;
  }

  private queueSettlement(
    active: ActiveTurn,
    acknowledgement: NonNullable<ActiveTurn["nativeGoalStartAcknowledgement"]>,
  ): void {
    if (acknowledgement.settlementQueued) return;
    acknowledgement.settlementQueued = true;
    queueMicrotask(() => {
      if (active.nativeGoalStartAcknowledgement !== acknowledgement) return;
      active.nativeGoalStartAcknowledgement = null;
      if (acknowledgement.cleared) {
        acknowledgement.reject(
          new Error("The Codex goal was cleared before it was confirmed."),
        );
        return;
      }
      if (acknowledgement.latestGoal) {
        acknowledgement.resolve(acknowledgement.latestGoal);
      }
    });
  }
}
