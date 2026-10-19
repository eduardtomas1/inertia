import {
  extractRoutingFeatures,
  type RoutingFeatures,
  type RoutingInput,
  type RoutingKeywordClass,
} from "./routing-features";
import {
  ROUTING_TIERS,
  type RoutingPickerId,
  type RoutingTaskKind,
  type RoutingTier,
} from "./routing-policy";

export interface PickerResult {
  tier: RoutingTier;
  taskKind: RoutingTaskKind;
  /** Margin between the two best tier scores, normalised to [0, 1]. */
  confidence: number;
  trace: string[];
}

/** Every picker implements this pure contract; it never returns a model id. */
export type RoutingPicker = (input: RoutingInput) => Promise<PickerResult>;

const KEYWORD_WEIGHTS: Readonly<Record<RoutingKeywordClass, number>> = {
  debugging: 1.5,
  review: 1.4,
  planning: 1.3,
  research: 1.2,
  small_edit: 1.6,
  feature: 1,
  question: 0.8,
};

/** Ties resolve toward the more specific kind of work. */
const TASK_KIND_PRIORITY: readonly RoutingKeywordClass[] = [
  "debugging",
  "review",
  "planning",
  "research",
  "small_edit",
  "feature",
  "question",
];

const TASK_KIND_TIER_SCORES: Readonly<Record<RoutingTaskKind, Partial<Record<RoutingTier, number>>>> = {
  question: { light: 2.5, standard: 0.5 },
  small_edit: { light: 2.5 },
  feature: { standard: 1.5, heavy: 1 },
  debugging: { standard: 0.5, heavy: 2.5 },
  review: { standard: 0.5, heavy: 2.5 },
  research: { standard: 0.5, heavy: 1.5 },
  planning: { heavy: 2.5, max: 1 },
  other: { standard: 1.5 },
};

/** A margin this wide between the two best tiers counts as full confidence. */
export const RULES_PICKER_CONFIDENCE_SCALE = 2.5;

/** Ties between tiers resolve toward Standard, then toward the cheaper tier. */
const TIER_TIE_ORDER: readonly RoutingTier[] = ["standard", "light", "heavy", "max"];

export function classifyRoutingTask(features: RoutingFeatures): { taskKind: RoutingTaskKind; trace: string } {
  const scores = new Map<RoutingKeywordClass, number>(
    TASK_KIND_PRIORITY.map((kind) => [kind, features.keywords[kind] * KEYWORD_WEIGHTS[kind]]),
  );
  if (features.stackTrace) scores.set("debugging", (scores.get("debugging") ?? 0) + 3);
  if (features.endsWithQuestion) scores.set("question", (scores.get("question") ?? 0) + 1);
  let best: RoutingKeywordClass | null = null;
  let bestScore = 0;
  for (const kind of TASK_KIND_PRIORITY) {
    const score = scores.get(kind) ?? 0;
    if (score > bestScore) {
      best = kind;
      bestScore = score;
    }
  }
  const taskKind = best ?? "other";
  return {
    taskKind,
    trace: best ? `task kind ${taskKind} (keyword score ${round(bestScore)})` : "task kind other (no keyword class)",
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function scoreRoutingTiers(
  features: RoutingFeatures,
  taskKind: RoutingTaskKind,
): { scores: Record<RoutingTier, number>; trace: string[] } {
  const scores: Record<RoutingTier, number> = { light: 0, standard: 0.5, heavy: 0, max: 0 };
  const trace: string[] = [];
  const add = (tier: RoutingTier, amount: number, why: string): void => {
    scores[tier] += amount;
    trace.push(`${tier} +${amount} ${why}`);
  };
  for (const [tier, amount] of Object.entries(TASK_KIND_TIER_SCORES[taskKind]) as Array<[RoutingTier, number]>) {
    add(tier, amount, `for ${taskKind}`);
  }
  if (features.chars < 80) add("light", 1, "short prompt");
  else if (features.chars < 400) add("standard", 0.5, "medium prompt");
  else if (features.chars < 1_500) add("heavy", 0.5, "long prompt");
  else if (features.chars < 6_000) {
    add("heavy", 1, "very long prompt");
    add("max", 0.5, "very long prompt");
  } else {
    add("heavy", 1, "huge prompt");
    add("max", 1.5, "huge prompt");
  }
  if (features.lines >= 40) add("heavy", 0.5, "many lines");
  if (features.codeFences >= 3) add("heavy", 1, "several code blocks");
  else if (features.codeFences >= 1) add("standard", 0.5, "code block");
  if (features.stackTrace) add("heavy", 1, "stack trace");
  if (features.attachments.image > 0) add("standard", 0.5, "image attached");
  if (features.attachments.document > 0) add("heavy", 0.5, "document attached");
  const attachmentCount = features.attachments.image + features.attachments.document + features.attachments.text;
  if (attachmentCount >= 4) add("heavy", 0.5, "many attachments");
  if (features.fileMentions >= 8) {
    add("heavy", 1, "many files referenced");
    add("max", 1, "many files referenced");
  } else if (features.fileMentions >= 3) add("heavy", 1, "several files referenced");
  if (features.chatMentions > 0) add("heavy", 0.5, "other chats referenced");
  if (features.previousTurnFailed) add("heavy", 2, "previous turn failed");
  if (features.intensity === "deep") {
    add("max", 3, "asks for depth");
  } else if (features.intensity === "quick") {
    add("light", 1, "asks for brevity");
  }
  if (
    !features.firstTurn
    && features.previousTier
    && taskKind === "other"
    && features.chars < 60
  ) {
    add(features.previousTier, 3.5, "short follow-up keeps the previous tier");
  }
  return { scores, trace };
}

export function rulesPickerDecision(input: RoutingInput): PickerResult {
  const features = extractRoutingFeatures(input);
  const classified = classifyRoutingTask(features);
  const { scores, trace } = scoreRoutingTiers(features, classified.taskKind);
  const ranked = [...ROUTING_TIERS].sort((left, right) =>
    scores[right] - scores[left] || TIER_TIE_ORDER.indexOf(left) - TIER_TIE_ORDER.indexOf(right));
  const top = ranked[0]!;
  const second = ranked[1]!;
  const confidence = Math.min(1, Math.max(0, (scores[top] - scores[second]) / RULES_PICKER_CONFIDENCE_SCALE));
  return {
    tier: top,
    taskKind: classified.taskKind,
    confidence: round(confidence),
    trace: [
      classified.trace,
      ...trace,
      `scores ${ROUTING_TIERS.map((tier) => `${tier}=${round(scores[tier])}`).join(" ")}`,
    ],
  };
}

export const rulesPicker: RoutingPicker = (input) => Promise.resolve(rulesPickerDecision(input));

export const ROUTING_PICKER_IMPLEMENTATIONS: Readonly<Record<RoutingPickerId, RoutingPicker>> = {
  rules: rulesPicker,
};
