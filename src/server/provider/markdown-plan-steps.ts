import { MAX_AGENT_PLAN_STEPS } from "../../shared/agent-plan";

export function markdownPlanSteps(
  markdown: string,
  maxStepChars: number,
): Array<{ step: string; status: "pending" }> {
  let fence: string | null = null;
  const steps: string[] = [];
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (!fence && marker) {
      fence = marker;
      continue;
    }
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length)) fence = null;
      continue;
    }
    const step = line.match(/^(?:[-*+]|\d+[.)])\s+(.+)/u)?.[1]?.trim();
    if (step) steps.push(step);
  }
  return steps
    .slice(0, MAX_AGENT_PLAN_STEPS)
    .map((step) => ({
      step: step.slice(0, maxStepChars),
      status: "pending",
    }));
}
