import { boundedText, objectValue, stringValue, type JsonObject } from "./protocol";
import type { AgentPlanStep } from "../provider/interactions";

export interface ParsedCodexPlan {
  explanation: string | null;
  steps: AgentPlanStep[];
}

export function parseCodexPlan(params: JsonObject): ParsedCodexPlan {
  const steps: AgentPlanStep[] = [];
  if (Array.isArray(params.plan)) {
    for (const value of params.plan.slice(0, 50)) {
      const planStep = objectValue(value);
      const step = boundedText(planStep?.step, 1_000);
      const status = stringValue(planStep?.status);
      if (!step || (status !== "pending" && status !== "inProgress" && status !== "completed")) continue;
      steps.push({ step, status });
    }
  }
  return { explanation: boundedText(params.explanation, 4_000) ?? null, steps };
}
