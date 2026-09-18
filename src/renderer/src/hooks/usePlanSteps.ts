import { useMemo } from "react";

import type {
  AgentPlan,
  ChatMessage,
  Conversation,
} from "@shared/contracts";
import { planFromText, type TextPlanStep } from "../utils/planFromText";
import type { StreamingAgentState } from "../utils/terminalTurnProjection";
import {
  EMPTY_STREAMING_AGENT_SOURCE,
  useStreamingAgentSelection,
  type StreamingAgentSource,
} from "./useStreamingAgentState";

function runningPlanSteps([text]: StreamingAgentState): TextPlanStep[] {
  return planFromText("", "running", text);
}

function samePlanSteps(
  left: readonly TextPlanStep[],
  right: readonly TextPlanStep[],
): boolean {
  return left.length === right.length && left.every((step, index) =>
    step.id === right[index]?.id
    && step.title === right[index]?.title
    && step.status === right[index]?.status);
}

export function usePlanSteps(
  plans: readonly AgentPlan[],
  messages: readonly ChatMessage[],
  status: Conversation["status"],
  streaming: StreamingAgentSource,
): TextPlanStep[] {
  const latestPlan = plans.at(-1);
  const streamed = !latestPlan && status === "running";
  const streamedSteps = useStreamingAgentSelection(
    streamed ? streaming : EMPTY_STREAMING_AGENT_SOURCE,
    runningPlanSteps,
    samePlanSteps,
  );
  const latestAssistantContent = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "assistant") return message.content;
    }
    return "";
  }, [messages]);
  return useMemo(() => {
    if (latestPlan) {
      return latestPlan.steps.map((step, index) => ({
        id: `native-${index}`,
        title: step.step,
        status: step.status === "inProgress"
          ? "in-progress" as const
          : step.status,
      }));
    }
    return streamed
      ? streamedSteps
      : planFromText(latestAssistantContent, status);
  }, [latestAssistantContent, latestPlan, status, streamed, streamedSteps]);
}
