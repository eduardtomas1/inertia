import type {
  AgentTurn,
  ChatMessage,
  Conversation,
  InteractionMode,
} from "@shared/contracts";

/**
 * Where a Plan tab step came from. Native steps are the provider's own plan;
 * streamed steps follow the running reply; derived steps are read from a
 * finished reply's list and are never tracked as progress.
 */
export type PlanStepSource = "native" | "streamed" | "derived";

export interface TextPlanStep {
  id: string;
  title: string;
  status: "pending" | "in-progress" | "completed" | "cancelled";
  source: PlanStepSource;
}

export function planFromText(
  text: string,
  status: Conversation["status"],
  streamingText?: string,
): TextPlanStep[] {
  // A running turn owns its plan, even before its first token arrives.
  const streamed = status === "running" && streamingText !== undefined;
  const source: PlanStepSource = streamed ? "streamed" : "derived";
  const lines = (streamed ? streamingText : text).split("\n");
  const candidates: TextPlanStep[] = lines.flatMap((line, index) => {
    const match =
      /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.{3,200})$/u.exec(line);
    if (!match) return [];
    return [{
      id: `step-${index}`,
      title: match[1].replace(/\*\*/g, "").trim(),
      status: "pending" as const,
      source,
    }];
  }).slice(0, 20);
  // Derived steps stay pending: a finished reply's list is not progress.
  if (streamed && candidates[0]) {
    candidates[0] = { ...candidates[0], status: "in-progress" };
  }
  return candidates;
}

/** Which text-parsed plan sources the Plan tab may show. */
export interface TextPlanGate {
  /** Steps parsed from the running reply. */
  streamed: boolean;
  /** Steps parsed from the latest finished reply. */
  derived: boolean;
}

/**
 * Steps parsed from reply text are shown only when that reply belongs to a
 * plan-mode turn. A running reply belongs to the newest turn; a finished
 * reply belongs to its own turn. The turn's recorded mode wins; the
 * conversation's current mode is the fallback while that turn is not yet
 * projected. Native provider plans are never gated.
 */
export function textPlanGate(
  messages: readonly Pick<ChatMessage, "role" | "turnId">[],
  turns: readonly Pick<AgentTurn, "id" | "interactionMode">[],
  conversationMode: InteractionMode | null,
): TextPlanGate {
  const planMode = (turn: Pick<AgentTurn, "interactionMode"> | undefined) =>
    (turn?.interactionMode ?? conversationMode) === "plan";
  let derived = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    derived = planMode(message.turnId
      ? turns.find(({ id }) => id === message.turnId)
      : undefined);
    break;
  }
  return { streamed: planMode(turns.at(-1)), derived };
}

export function visiblePlanSteps<Step extends { source?: PlanStepSource }>(
  steps: Step[],
  gate: TextPlanGate,
): Step[] {
  const allowed = ({ source }: Step) =>
    source === undefined || source === "native" || gate[source];
  return steps.every(allowed) ? steps : steps.filter(allowed);
}

/**
 * Steps the provider reported or is streaming in a plan-mode turn; pass
 * steps already filtered by visiblePlanSteps. Derived steps never count.
 */
export function reportedPlanStepCount(
  steps: readonly { source?: PlanStepSource }[],
): number {
  return steps.filter(({ source }) => source !== "derived").length;
}
