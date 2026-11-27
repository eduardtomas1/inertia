import type { ClientCommand } from "../../../shared/contracts";
import type { QueueEvent } from "../../../shared/orchestration-queue";
import type { RunInterruptCause } from "../../../shared/orchestration-run-control";
import type { OrchestrationDomainEvent } from "../../../shared/orchestration-v2";
import { isAgentTurnTerminalStatus } from "../../../shared/turn-lifecycle";
import type { CommandRejectionPolicy } from "../../orchestration-v2/command-authority";
import type { CommandSource, JsonValue } from "../../orchestration-v2/types";
import { ownedProviderStopBudgetMs } from "../../provider/run-cleanup-settlement";
import { RuntimeRequestError } from "../../runtime-errors";
import { takeInterruptOutcome } from "../run-control-effect-handlers";
import { commandRejection } from "./command-rejection";
import type { TurnOwnerIdentity } from "../turns/turn-ownership";
import type { TurnInteractionCommandDependencies } from "./turn-interaction-types";

const AGENT_STOP_SETTLEMENT_WAIT_MS = ownedProviderStopBudgetMs() + 2_000;
export const SUPERSEDED_STOP_MESSAGE = "A newer run has already started in this thread. Nothing was stopped.";
export const SUPERSEDED_STOP_CODE = "superseded";

type StopDependencies = Pick<TurnInteractionCommandDependencies, "store" | "turns">
  & Partial<Pick<TurnInteractionCommandDependencies, "isolatedRuns" | "broadcast">>;

type StopIntake =
  | { kind: "idle"; queueChanged: boolean }
  | { kind: "isolated"; queueChanged: boolean }
  | { kind: "releasing"; queueChanged: boolean }
  | {
      kind: "turn";
      owner: TurnOwnerIdentity;
      runId: string | null;
      effectId: string | null;
      earlierSteers: readonly string[];
      queueChanged: boolean;
    };

/** `ended`: the run this Stop recorded had already ended on its own when the cancel ran; nothing was stopped. */
export type AgentStopDisposition = "replayed" | "joined" | "ended" | StopIntake["kind"];

export interface AgentStopRequest {
  conversationId: string;
  expectedTurnId: string | null;
  /** An approval names one exact run; a Stop for any other run of that turn is superseded. */
  expectedRunId?: string | null;
  /** Recorded on the interrupt so an agent's Stop never reads as the user's. */
  cause: RunInterruptCause;
  source: CommandSource;
  rejection: CommandRejectionPolicy | null;
  /** Optional extra events & SQL callback committed atomically in the same Stop transaction (e.g. stop-and-send). */
  extraEvents?: readonly OrchestrationDomainEvent[];
  extraAfterCommit?: () => void;
  /** Set true when the caller handles holding queue items itself (default false: Stop atomically holds all unheld active items). */
  skipQueueHold?: boolean;
  /** When false, reject with `superseded` before committing if the expected turn is no longer live at stop intake (default true). */
  commitExtraEventsOnNoOp?: boolean;
}

function unheldQueueHoldPlan(
  store: StopDependencies["store"],
  conversationId: string,
  skipQueueHold: boolean,
): { events: QueueEvent[]; afterCommit: () => void; heldIds: string[] } {
  const queue = store.orchestration?.queue;
  if (skipQueueHold || !queue) return { events: [], afterCommit: () => undefined, heldIds: [] };
  const activeV2 = queue.listActive(conversationId);
  const unheldIds = activeV2.filter((item) => !item.queueHeld).map(({ id }) => id);
  if (unheldIds.length === 0) return { events: [], afterCommit: () => undefined, heldIds: [] };
  const events: QueueEvent[] = [{ type: "queue.items-held", payload: { itemIds: unheldIds, cause: "H1-stop" } }];
  const afterCommit = (): void => {
    const db = store.orchestration?.effects?.connection;
    if (!db) return;
    const update = db.prepare(
      "UPDATE queued_messages SET queue_held = 1 WHERE id = ? AND conversation_id = ?",
    );
    for (const itemId of unheldIds) update.run(itemId, conversationId);
  };
  return { events, afterCommit, heldIds: unheldIds };
}

export async function requestAgentStop(dependencies: StopDependencies, request: AgentStopRequest): Promise<AgentStopDisposition> {
  const { store, turns, isolatedRuns } = dependencies;
  const { conversationId, expectedTurnId } = request;
  const conversation = store.conversation(conversationId);
  const runControl = store.orchestration.runControl;
  const start = await store.orchestration.authority.begin<StopIntake>({
    source: request.source, threadId: conversation.id, projectId: conversation.projectId,
    commandType: "agent.stop", rejection: request.rejection,
  }, (ticket) => {
    const holdPlan = unheldQueueHoldPlan(store, conversationId, request.skipQueueHold === true);
    const combinedEvents: OrchestrationDomainEvent[] = [...holdPlan.events, ...(request.extraEvents ?? [])];
    const runAfterCommit = (): void => {
      holdPlan.afterCommit();
      request.extraAfterCommit?.();
    };
    const queueChanged = holdPlan.heldIds.length > 0 || (request.extraEvents?.length ?? 0) > 0;
    const rejectNoOp = request.commitExtraEventsOnNoOp === false;
    if (isolatedRuns?.has(conversationId)) {
      if (rejectNoOp) {
        throw new RuntimeRequestError(SUPERSEDED_STOP_MESSAGE, SUPERSEDED_STOP_CODE);
      }
      ticket.commit({ events: combinedEvents, result: { stop: "isolated" } }, runAfterCommit);
      return { kind: "isolated", queueChanged };
    }
    const owner = turns.activeIdentity(conversationId);
    if (!owner) {
      if (rejectNoOp) {
        throw new RuntimeRequestError(SUPERSEDED_STOP_MESSAGE, SUPERSEDED_STOP_CODE);
      }
      const kind = turns.isReleasing(conversationId) ? "releasing" : "idle";
      // Idle Stop with no unheld queued items and no extra events writes 0 domain events.
      ticket.commit({ events: combinedEvents, result: { stop: kind } }, runAfterCommit);
      return { kind, queueChanged };
    }
    if ((expectedTurnId !== null && owner.turnId !== expectedTurnId)
      || (request.expectedRunId != null && owner.runId !== request.expectedRunId)) {
      throw new RuntimeRequestError(SUPERSEDED_STOP_MESSAGE, SUPERSEDED_STOP_CODE);
    }
    const target = runControl.target(owner.runId);
    if (!target || target.terminal || target.turnId !== owner.turnId) {
      if (rejectNoOp && expectedTurnId !== null) {
        if (target !== null) {
          throw new RuntimeRequestError(SUPERSEDED_STOP_MESSAGE, SUPERSEDED_STOP_CODE);
        }
        let turnTerminal = false;
        try {
          turnTerminal = isAgentTurnTerminalStatus(store.agentTurn(owner.turnId).status);
        } catch {
          turnTerminal = true;
        }
        if (turnTerminal) {
          throw new RuntimeRequestError(SUPERSEDED_STOP_MESSAGE, SUPERSEDED_STOP_CODE);
        }
      }
      ticket.commit({ events: combinedEvents, result: { stop: "untracked", runId: owner.runId } }, runAfterCommit);
      return { kind: "turn", owner, runId: null, effectId: null, earlierSteers: [], queueChanged };
    }
    if (!target.interruptRequested) {
      const effectId = runControl.recordInterrupt(ticket, target, expectedTurnId, request.cause, {
        events: combinedEvents,
        afterCommit: runAfterCommit,
      });
      return { kind: "turn", owner, runId: target.runId, effectId, earlierSteers: runControl.unsettledSteersBefore(effectId), queueChanged };
    }
    runControl.escalateByRequester(ticket, target, request.cause, {
      events: combinedEvents,
      afterCommit: runAfterCommit,
    });
    return { kind: "turn", owner, runId: null, effectId: null, earlierSteers: runControl.unsettledSteers(target.threadId), queueChanged };
  });
  if (start.kind === "replay") return "replayed";
  if (start.kind === "rejected") throw new RuntimeRequestError(start.detail);
  if (start.kind === "joined") {
    await start.result;
    return "joined";
  }
  const { ticket, intake } = start;
  try {
    if (intake.queueChanged && dependencies.broadcast) {
      dependencies.broadcast({
        type: "conversation.queue.changed",
        conversationId,
        revision: store.orchestration?.queue?.revision(conversationId) ?? 0,
      });
      dependencies.broadcast({ type: "conversation.detail.invalidated", conversationId });
    }
    if (intake.kind === "isolated") isolatedRuns?.stopConversation(conversationId);
    if (intake.kind !== "turn") return intake.kind;
    if (intake.effectId && runControl.dispatchesViaEffectRuntime("provider.interrupt")) {
      await runControl.awaitSettled([intake.effectId], Date.now() + ownedProviderStopBudgetMs());
      const outcome = takeInterruptOutcome(intake.effectId);
      return outcome === "ended" ? "ended" : intake.kind;
    }
    if (intake.earlierSteers.length > 0) {
      await runControl.awaitSettled(intake.earlierSteers, Date.now() + ownedProviderStopBudgetMs());
    }
    let cancelled: boolean;
    try {
      // Only the run this Stop recorded: a follow-up may have started while it waited for earlier steers.
      cancelled = turns.cancelExact(conversationId, intake.owner);
    } catch (error) {
      if (intake.runId) runControl.settleInterrupt(intake.runId, "failed");
      throw error;
    }
    return cancelled ? intake.kind : "ended";
  } finally {
    ticket.finish(null);
  }
}

export async function stopAgentCommand(
  dependencies: StopDependencies,
  command: Extract<ClientCommand, { type: "agent.stop" }>,
): Promise<"mutation"> {
  const disposition = await requestAgentStop(dependencies, {
    conversationId: command.payload.conversationId,
    expectedTurnId: command.payload.expectedTurnId ?? null,
    cause: "user",
    source: { actorId: "human", commandId: command.requestId, command: JSON.parse(JSON.stringify(command)) as JsonValue },
    rejection: commandRejection,
  });
  if (disposition === "turn" || disposition === "releasing" || disposition === "ended") {
    await dependencies.turns.waitForProviderCleanup(
      [command.payload.conversationId],
      Date.now() + AGENT_STOP_SETTLEMENT_WAIT_MS,
    );
  }
  return "mutation";
}
