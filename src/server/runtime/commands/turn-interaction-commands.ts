import { RuntimeRequestError } from "../../runtime-errors";
import { pendingInteractionForConversation } from "../pending-interaction-registry";
import { stopAgentCommand } from "./agent-stop-command";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";
import { sendMessageCommand } from "./message-send-command";
import type { TurnInteractionCommandDependencies } from "./turn-interaction-types";

export type { CompactionHandoff, TurnInteractionCommandDependencies } from "./turn-interaction-types";

export function createTurnInteractionCommandHandler(
  dependencies: TurnInteractionCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "message.send",
    "agent.stop",
    "agent.subagent.stop",
    "activity.stop",
    "activity.dismiss",
    "activity.mark-seen",
    "activity.acknowledge",
    "agent.approval.respond",
    "agent.input.respond",
  ], async (socket, command) => {
    switch (command.type) {
      case "message.send":
        return await sendMessageCommand(dependencies, socket, command);
      case "agent.stop":
        return await stopAgentCommand(dependencies, command);
      case "agent.subagent.stop":
        if (
          !await dependencies.turns.stopSubagent(
            command.payload.conversationId,
            command.payload.traceId,
          )
        ) {
          throw new RuntimeRequestError(
            "That delegated Claude task is no longer live or cannot be stopped.",
          );
        }
        return "mutation";
      case "activity.stop": {
        const activity = dependencies.store.workspaceRun(
          command.payload.runId,
        );
        if (
          activity.status !== "running"
          && activity.status !== "waiting"
        ) {
          throw new RuntimeRequestError(
            "That activity has already finished.",
          );
        }
        if (activity.kind === "check" || activity.kind === "service" || activity.kind === "source-control") {
          if (!await dependencies.workspaceRuns.stopManagedAction(activity.id)) {
            throw new RuntimeRequestError(
              "That process is no longer owned by the local runtime.",
            );
          }
          return "mutation";
        }
        if (activity.kind !== "agent" || !activity.conversationId) {
          throw new RuntimeRequestError(
            "This activity cannot be stopped safely.",
          );
        }
        if (dependencies.isolatedRuns.ownsWorkspaceRun(activity.id)) {
          if (!dependencies.isolatedRuns.stopWorkspaceRun(activity.id)) {
            throw new RuntimeRequestError(
              "That isolated review has already finished.",
            );
          }
          return "mutation";
        }
        if (
          !dependencies.isolatedRuns.stopConversation(
            activity.conversationId,
          )
          && !dependencies.turns.cancel(activity.conversationId)
        ) {
          throw new RuntimeRequestError(
            "That agent run is no longer active.",
          );
        }
        return "mutation";
      }
      case "activity.dismiss":
        dependencies.store.dismissWorkspaceRun(command.payload.runId);
        return "mutation";
      case "activity.mark-seen":
        dependencies.store.markWorkspaceRunSeen(command.payload.runId);
        return "mutation";
      case "activity.acknowledge":
        dependencies.store.acknowledgeWorkspaceRun(command.payload.runId);
        return "mutation";
      case "agent.approval.respond": {
        const pending = pendingInteractionForConversation(
          dependencies.pendingApprovals,
          command.payload.conversationId,
          command.payload.requestId,
        );
        if (
          !pending
          || pending.conversationId !== command.payload.conversationId
        ) {
          throw new RuntimeRequestError(
            "That approval request is no longer pending.",
          );
        }
        if (
          !pending.availableDecisions.includes(command.payload.decision)
        ) {
          throw new RuntimeRequestError(
            "That response is not available for this approval request.",
          );
        }
        if (
          !dependencies.turns.respondToApproval(
            command.payload.conversationId,
            command.payload.requestId,
            command.payload.decision,
          )
        ) {
          throw new RuntimeRequestError(
            "That approval request is no longer pending.",
          );
        }
        return "mutation";
      }
      case "agent.input.respond": {
        const pending = pendingInteractionForConversation(
          dependencies.pendingInputs,
          command.payload.conversationId,
          command.payload.requestId,
        );
        if (
          !pending
          || pending.conversationId !== command.payload.conversationId
        ) {
          throw new RuntimeRequestError(
            "That question is no longer pending.",
          );
        }
        const expected = new Map(
          pending.questions.map((question) => [question.id, question]),
        );
        const invalidAnswer = Object.entries(command.payload.answers).some(
          ([id, values]) => {
            const question = expected.get(id);
            if (
              !question
              || values.length === 0
              || (!question.allowMultiple && values.length !== 1)
            ) {
              return true;
            }
            const optionIds = new Set(
              question.options.map((option) => option.id),
            );
            return values.some((value) => (
              !optionIds.has(value)
              && !question.isOther
              && question.options.length > 0
            ));
          },
        );
        if (
          invalidAnswer
          || [...expected.keys()].some(
            (id) => !command.payload.answers[id]?.length,
          )
        ) {
          throw new RuntimeRequestError(
            "Answer every question before continuing.",
          );
        }
        if (
          !dependencies.turns.respondToInput(
            command.payload.conversationId,
            command.payload.requestId,
            command.payload.answers,
          )
        ) {
          throw new RuntimeRequestError(
            "That question is no longer pending.",
          );
        }
        return "mutation";
      }
      default:
        return "not-handled";
    }
  });
}
