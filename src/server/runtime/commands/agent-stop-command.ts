import type { ClientCommand } from "../../../shared/contracts";
import type { CommandRejectionPolicy } from "../../orchestration-v2/command-authority";
import type { CommandSource, JsonValue } from "../../orchestration-v2/types";
import { ownedProviderStopBudgetMs } from "../../provider/run-cleanup-settlement";
import { RuntimeRequestError } from "../../runtime-errors";
import { commandRejection } from "./command-rejection";
import type { TurnInteractionCommandDependencies } from "./turn-interaction-types";

const AGENT_STOP_SETTLEMENT_WAIT_MS = ownedProviderStopBudgetMs() + 2_000;
export const SUPERSEDED_STOP_MESSAGE = "A newer run has already started in this thread. Nothing was stopped.";
export const SUPERSEDED_STOP_CODE = "superseded";

type StopDependencies = Pick<TurnInteractionCommandDependencies, "store" | "turns" | "isolatedRuns">;

type StopIntake =
  | { kind: "idle" }
  | { kind: "isolated" }
  | { kind: "releasing" }
  | { kind: "turn"; runId: string | null; earlierSteers: readonly string[] };

export type AgentStopDisposition = "replayed" | "joined" | StopIntake["kind"];

export interface AgentStopRequest {
  conversationId: string;
  expectedTurnId: string | null;
  source: CommandSource;
  rejection: CommandRejectionPolicy | null;
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
    if (isolatedRuns.has(conversationId)) {
      ticket.commit({ events: [], result: { stop: "isolated" } });
      return { kind: "isolated" };
    }
    const owner = turns.activeIdentity(conversationId);
    if (!owner) {
      const kind = turns.isReleasing(conversationId) ? "releasing" : "idle";
      ticket.commit({ events: [], result: { stop: kind } });
      return { kind };
    }
    if (expectedTurnId !== null && owner.turnId !== expectedTurnId) {
      throw new RuntimeRequestError(SUPERSEDED_STOP_MESSAGE, SUPERSEDED_STOP_CODE);
    }
    const target = runControl.target(owner.runId);
    if (!target || target.terminal || target.turnId !== owner.turnId) {
      ticket.commit({ events: [], result: { stop: "untracked", runId: owner.runId } });
      return { kind: "turn", runId: null, earlierSteers: [] };
    }
    if (!target.interruptRequested) {
      const effectId = runControl.recordInterrupt(ticket, target, expectedTurnId);
      return { kind: "turn", runId: target.runId, earlierSteers: runControl.unsettledSteersBefore(effectId) };
    }
    runControl.escalateByUser(ticket, target);
    return { kind: "turn", runId: null, earlierSteers: runControl.unsettledSteers(target.threadId) };
  });
  if (start.kind === "replay") return "replayed";
  if (start.kind === "rejected") throw new RuntimeRequestError(start.detail);
  if (start.kind === "joined") {
    await start.result;
    return "joined";
  }
  const { ticket, intake } = start;
  try {
    if (intake.kind === "isolated") isolatedRuns.stopConversation(conversationId);
    if (intake.kind !== "turn") return intake.kind;
    if (intake.earlierSteers.length > 0) {
      await runControl.awaitSettled(intake.earlierSteers, Date.now() + ownedProviderStopBudgetMs());
    }
    try {
      turns.cancel(conversationId);
    } catch (error) {
      if (intake.runId) runControl.settleInterrupt(intake.runId, "failed");
      throw error;
    }
    return intake.kind;
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
    source: { actorId: "human", commandId: command.requestId, command: JSON.parse(JSON.stringify(command)) as JsonValue },
    rejection: commandRejection,
  });
  if (disposition === "turn" || disposition === "releasing") {
    await dependencies.turns.waitForProviderCleanup(
      [command.payload.conversationId],
      Date.now() + AGENT_STOP_SETTLEMENT_WAIT_MS,
    );
  }
  return "mutation";
}
