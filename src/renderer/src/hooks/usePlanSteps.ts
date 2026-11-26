import { useCallback, useMemo, useRef } from "react";

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

const EMPTY_PLAN_STEPS: TextPlanStep[] = [];

function samePlanSteps(
  left: readonly TextPlanStep[],
  right: readonly TextPlanStep[],
): boolean {
  if (left === right) return true;
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
  streamedEnabled = true,
): TextPlanStep[] {
  const latestPlan = plans.at(-1);
  const streamed = streamedEnabled && !latestPlan && status === "running";
  const lastStreamedRef = useRef<{ text: string; steps: TextPlanStep[] }>({
    text: "",
    steps: EMPTY_PLAN_STEPS,
  });
  const selectRunningPlanSteps = useCallback(
    ([text]: StreamingAgentState): TextPlanStep[] => {
      if (text === lastStreamedRef.current.text) {
        return lastStreamedRef.current.steps;
      }
      const steps = planFromText("", "running", text);
      lastStreamedRef.current = { text, steps };
      return steps;
    },
    [],
  );
  const streamedSteps = useStreamingAgentSelection(
    streamed ? streaming : EMPTY_STREAMING_AGENT_SOURCE,
    selectRunningPlanSteps,
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
        source: "native" as const,
      }));
    }
    if (status === "running") {
      return streamed ? streamedSteps : EMPTY_PLAN_STEPS;
    }
    // Text-parsed steps are gated on plan mode by visiblePlanSteps.
    return planFromText(latestAssistantContent, status);
  }, [latestAssistantContent, latestPlan, status, streamed, streamedSteps]);
}
