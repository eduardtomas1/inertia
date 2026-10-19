import type { RoutingTaskKind, RoutingTier } from "./routing-policy";

export type RoutingAttachmentKind = "image" | "document" | "text";

/**
 * Everything a picker may see. It is built locally from the message being
 * sent and the chat's own turn ledger; in this release it never leaves the
 * runtime process.
 */
export interface RoutingInput {
  content: string;
  attachments: readonly RoutingAttachmentKind[];
  /** Structured file references attached through the composer. */
  fileReferenceCount: number;
  /** Other chats referenced through context packets. */
  chatMentionCount: number;
  priorTurnCount: number;
  previousTurnFailed: boolean;
  /** Tier chosen for this chat's latest routed turn, when there was one. */
  previousTier: RoutingTier | null;
}

export type RoutingKeywordClass = Exclude<RoutingTaskKind, "other">;

export interface RoutingFeatures {
  chars: number;
  lines: number;
  codeFences: number;
  stackTrace: boolean;
  endsWithQuestion: boolean;
  attachments: Readonly<Record<RoutingAttachmentKind, number>>;
  fileMentions: number;
  chatMentions: number;
  keywords: Readonly<Record<RoutingKeywordClass, number>>;
  intensity: "quick" | "deep" | null;
  firstTurn: boolean;
  priorTurns: number;
  previousTurnFailed: boolean;
  previousTier: RoutingTier | null;
}

/** Only the head of a long prompt is scanned so feature extraction stays bounded. */
export const ROUTING_FEATURE_SCAN_CHARS = 32_768;
const MAX_KEYWORD_HITS = 5;

const KEYWORD_PATTERNS: Readonly<Record<RoutingKeywordClass, readonly RegExp[]>> = {
  debugging: [
    /\b(?:fix(?:es|ed|ing)?|debug(?:s|ging)?|bugs?|errors?|exceptions?|crash(?:es|ed|ing)?|fail(?:s|ed|ing|ure)?|broken|regression|stack ?trace|traceback|segfault|panic(?:s|ked)?)\b/giu,
    /\b(?:doesn'?t|does not|isn'?t|is not|not) work(?:ing)?\b/giu,
  ],
  feature: [
    /\b(?:refactor(?:s|ing)?|implement(?:s|ing|ation)?|add(?:s|ing)?|build(?:s|ing)?|creat(?:e|es|ing)|introduce|support|migrat(?:e|ion)|rewrite|integrate|wire(?: up)?|scaffold)\b/giu,
  ],
  question: [
    /\b(?:explain|what|why|how|where|which|who|when)\b/giu,
    /\b(?:is there|are there|can you tell|tell me|walk me through)\b/giu,
  ],
  review: [
    /\b(?:review(?:s|ing)?|audit(?:s|ing)?|critique|look over|sanity[- ]check|code review)\b/giu,
  ],
  research: [
    /\b(?:compare|comparison|research|find out|investigate|evaluate|survey|alternatives|pros and cons|trade-?offs?)\b/giu,
  ],
  planning: [
    /\b(?:plan(?:s|ning)?|design(?:s|ing)?|architect(?:ure|ural)?|roadmap|strategy|proposal|spec(?:ification)?|outline)\b/giu,
  ],
  small_edit: [
    /\b(?:typos?|renam(?:e|es|ing)|small change|tweak|one[- ]line(?:r)?|wording|bump|minor|spelling|reword)\b/giu,
  ],
};

const DEEP_PATTERN = /\b(?:think hard|ultrathink|thoroughly|carefully|deep dive|in depth|in-depth|complex|tricky|hard problem|rigorous(?:ly)?)\b/iu;
const QUICK_PATTERN = /\b(?:quick(?:ly)?|briefly|short answer|tl;?dr|just|simple|one sentence)\b/iu;
const STACK_TRACE_PATTERNS = [
  /^\s+at\s+\S.*\(?.+:\d+(?::\d+)?\)?\s*$/mu,
  /Traceback \(most recent call last\)/u,
  /^\s*File ".+", line \d+/mu,
  /\bpanicked at\b/u,
];
const FILE_MENTION_PATTERN = /(?:^|\s)@(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+\b/gu;

export function routingAttachmentKind(mimeType: string): RoutingAttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  return "document";
}

function countMatches(text: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    count += text.match(pattern)?.length ?? 0;
    if (count >= MAX_KEYWORD_HITS) return MAX_KEYWORD_HITS;
  }
  return count;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function extractRoutingFeatures(input: RoutingInput): RoutingFeatures {
  const content = input.content.slice(0, ROUTING_FEATURE_SCAN_CHARS);
  const trimmed = content.trim();
  const fences = content.match(/^\s*```/gmu)?.length ?? 0;
  // Inline code blocks may be quoted for keywords; strip fenced code before matching words.
  const prose = content.replace(/```[\s\S]*?(?:```|$)/gu, " ");
  const attachments = { image: 0, document: 0, text: 0 };
  for (const kind of input.attachments) attachments[kind] += 1;
  const keywords = Object.fromEntries(
    Object.entries(KEYWORD_PATTERNS).map(([kind, patterns]) => [kind, countMatches(prose, patterns)]),
  ) as Record<RoutingKeywordClass, number>;
  const stackTrace = STACK_TRACE_PATTERNS.some((pattern) => pattern.test(content));
  const deep = DEEP_PATTERN.test(prose);
  const quick = !deep && QUICK_PATTERN.test(prose);
  const priorTurns = nonNegativeInteger(input.priorTurnCount);
  return {
    chars: input.content.length,
    lines: trimmed ? trimmed.split(/\r?\n/u).length : 0,
    codeFences: Math.floor(fences / 2) + (fences % 2),
    stackTrace,
    endsWithQuestion: /\?\s*$/u.test(trimmed),
    attachments,
    fileMentions: nonNegativeInteger(input.fileReferenceCount)
      + (prose.match(FILE_MENTION_PATTERN)?.length ?? 0),
    chatMentions: nonNegativeInteger(input.chatMentionCount),
    keywords,
    intensity: deep ? "deep" : quick ? "quick" : null,
    firstTurn: priorTurns === 0,
    priorTurns,
    previousTurnFailed: input.previousTurnFailed,
    previousTier: input.previousTier,
  };
}
