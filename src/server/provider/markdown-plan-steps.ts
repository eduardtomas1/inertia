export function markdownPlanSteps(
  markdown: string,
  maxStepChars: number,
): Array<{ step: string; status: "pending" }> {
  const parsed = markdown
    .split("\n")
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)/u)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return (parsed.length > 0 ? parsed : [markdown])
    .slice(0, 100)
    .map((step) => ({
      step: step.slice(0, maxStepChars),
      status: "pending",
    }));
}
