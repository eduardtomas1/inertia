import type {
  AgentTurn,
  ChatMessage,
  Conversation,
  InteractionMode,
} from "@shared/contracts";

const TERMINAL_TURN_STATUSES: ReadonlySet<AgentTurn["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

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
 * projected. A finished last turn that is not the conversation's latest turn
 * belongs to an earlier exchange, so it never decides the running reply.
 * Native provider plans are never gated.
 */
export function textPlanGate(
  messages: readonly Pick<ChatMessage, "role" | "turnId">[],
  turns: readonly (Pick<AgentTurn, "id" | "interactionMode"> & { status?: AgentTurn["status"] })[],
  conversationMode: InteractionMode | null,
  latestTurnId: string | null = null,
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
  const lastTurn = turns.at(-1);
  const runningTurn = lastTurn
    && (lastTurn.status === undefined || !TERMINAL_TURN_STATUSES.has(lastTurn.status) || lastTurn.id === latestTurnId)
    ? lastTurn
    : undefined;
  return { streamed: planMode(runningTurn), derived };
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

/** The most plan text an Implement message carries. */
export const PLAN_IMPLEMENTATION_MAX_BYTES = 16 * 1024;

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

function trimmedToBytes(text: string, maximum: number): { text: string; trimmed: boolean } {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += utf8Length(character.codePointAt(0)!);
    if (bytes > maximum) {
      const cut = text.slice(0, end);
      const lineEnd = cut.lastIndexOf("\n");
      return { text: (lineEnd > 0 ? cut.slice(0, lineEnd) : cut).trimEnd(), trimmed: true };
    }
    end += character.length;
  }
  return { text, trimmed: false };
}

/**
 * The message the Plan panel's Implement actions send: the plan itself, so the
 * request stands on its own after compaction, in a new chat, or with another
 * provider. Plan text over 16 KiB is cut at a line boundary and says so.
 */
export function planImplementationMessage(input: {
  document?: string | null;
  steps: readonly { title: string; detail?: string | null; source?: PlanStepSource }[];
}): string {
  const derived = input.steps.length > 0 && input.steps.every(({ source }) => source === "derived");
  const plan = input.document?.trim()
    || input.steps.map(({ title, detail }, index) => (
      detail?.trim() ? `${index + 1}. ${title}\n   ${detail.trim()}` : `${index + 1}. ${title}`
    )).join("\n");
  const bounded = trimmedToBytes(plan, PLAN_IMPLEMENTATION_MAX_BYTES);
  return [
    "Implement this plan and validate the result.",
    ...(derived ? ["Derived from the reply: the provider did not report a plan, so these steps come from the list in its reply."] : []),
    "",
    bounded.text,
    ...(bounded.trimmed ? ["", "The plan above was trimmed to its first 16 KiB."] : []),
  ].join("\n");
}
