import type { Conversation } from "@shared/contracts";

export interface TextPlanStep {
  id: string;
  title: string;
  status: "pending" | "in-progress" | "completed";
}

export function planFromText(
  text: string,
  status: Conversation["status"],
  streamingText?: string,
): TextPlanStep[] {
  // A running turn owns its plan, even before its first token arrives.
  const lines = (status === "running" && streamingText !== undefined
    ? streamingText : text).split("\n");
  const candidates: TextPlanStep[] = lines.flatMap((line, index) => {
    const match =
      /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.{3,200})$/u.exec(line);
    if (!match) return [];
    return [{
      id: `step-${index}`,
      title: match[1].replace(/\*\*/g, "").trim(),
      status: "pending" as const,
    }];
  }).slice(0, 20);
  if (status === "running" && candidates[0]) {
    candidates[0] = { ...candidates[0], status: "in-progress" };
  }
  if (status === "completed") {
    return candidates.map((step) => ({
      ...step,
      status: "completed" as const,
    }));
  }
  return candidates;
}
