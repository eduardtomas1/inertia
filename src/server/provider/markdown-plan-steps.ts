import { MAX_AGENT_PLAN_STEPS } from "../../shared/agent-plan";

export function markdownPlanSteps(
  markdown: string,
  maxStepChars: number,
): Array<{ step: string; status: "pending" }> {
  let fenced = false;
  const steps: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    const step = fenced ? undefined : line.match(/^(?:[-*+]|\d+[.)])\s+(.+)/u)?.[1]?.trim();
    if (step) steps.push(step);
  }
  return steps
    .slice(0, MAX_AGENT_PLAN_STEPS)
    .map((step) => ({
      step: step.slice(0, maxStepChars),
      status: "pending",
    }));
}
