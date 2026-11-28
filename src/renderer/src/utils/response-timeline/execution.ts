import type {
  AgentActivity,
  ChatMessage,
} from "@shared/contracts";
import {
  activityNeedsAttention,
} from "./activity-attention";
import type { ResponseTurn } from "./model";
import type { SubagentCallEntry } from "./subagentCalls";
import type { SubagentGroupEntry } from "./subagentGroups";
import type { SecretRequestMessage } from "./secretRequests";
import type { SentToUserMessage } from "@shared/send-to-user";

export {
  activityAttentionSeverity,
  activityNeedsAttention,
  isInterruptedActivity,
  type ActivityAttentionSeverity,
} from "./activity-attention";

import {
  EN_COLLATOR,
  compareTimestampsAsc as compareTimestamps,
} from "../fastCompare";

export interface ActivityDetailPresentation {
  preview: string | null;
  full: string | null;
  expandable: boolean;
}

export const MAX_ACTIVITY_DETAIL_PREVIEW_LINES = 3;
const MAX_ACTIVITY_DETAIL_PREVIEW_LINE_CHARS = 160;

/**
 * Raw provider detail remains bounded behind a disclosure. The transcript gets
 * at most three compact lines and never measures or paints the full payload
 * until the user intentionally expands it.
 */
export function activityDetailPresentation(
  activity: Pick<AgentActivity, "detail" | "kind" | "status">,
): ActivityDetailPresentation {
  const full = activity.detail?.replace(/\r\n?/gu, "\n").trim() || null;
  if (!full) return { preview: null, full: null, expandable: false };
  const lines = full
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, values) =>
      Boolean(line.trim()) || (index > 0 && index < values.length - 1));
  const previewLines = lines
    .slice(0, MAX_ACTIVITY_DETAIL_PREVIEW_LINES)
    .map((line) =>
      line.length > MAX_ACTIVITY_DETAIL_PREVIEW_LINE_CHARS
        ? `${line.slice(0, MAX_ACTIVITY_DETAIL_PREVIEW_LINE_CHARS - 1)}…`
        : line);
  const preview = previewLines.join("\n") || null;
  const technical = activity.kind === "command"
    || activity.kind === "tool"
    || activity.status === "failed"
    || full.length > MAX_ACTIVITY_DETAIL_PREVIEW_LINE_CHARS
    || lines.length > 1
    || /^(?:Command|Error|Output):/mu.test(full);
  return {
    preview,
    full,
    expandable: technical,
  };
}

export function isTranscriptActivity(activity: AgentActivity): boolean {
  return activity.kind === "tool"
    || activity.kind === "command"
    || activity.kind === "file"
    || activityNeedsAttention(activity);
}

const COMPACTION_LIFECYCLE_TITLE = /^(?:.+ is compacting (?:session )?context|.+ compacted (?:the )?(?:session )?context|Context compacted|Context compaction)$/u;

export function isCompactionActivity(activity: AgentActivity): boolean {
  return activity.kind === "status"
    && COMPACTION_LIFECYCLE_TITLE.test(activity.title)
    && !activityNeedsAttention(activity);
}

export type TurnExecutionStreamEntry =
  | {
      kind: "commentary";
      id: string;
      createdAt: string;
      message: ChatMessage | null;
      content: string;
      streaming: boolean;
      answer?: true;
    }
  | {
      kind: "follow-up";
      id: string;
      createdAt: string;
      message: ChatMessage;
    }
  | {
      /** Markdown the agent showed the user mid-turn, at its place among the work. */
      kind: "sent-message";
      id: string;
      createdAt: string;
      message: SentToUserMessage;
    }
  | {
      kind: "secret-request";
      id: string;
      createdAt: string;
      message: SecretRequestMessage;
    }
  | {
      kind: "activity-group";
      id: string;
      createdAt: string;
      activities: AgentActivity[];
    }
  | {
      kind: "compaction";
      id: string;
      createdAt: string;
      activities: AgentActivity[];
    };

export type TurnWorkStreamEntry =
  | TurnExecutionStreamEntry
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      message: ChatMessage;
    }
  | SubagentCallEntry
  | SubagentGroupEntry;

/**
 * What a settled turn keeps in view when its work folds: the exchange with the
 * user (follow-ups and their answers, messages and pages the agent showed,
 * secret cards, called agents) rather than the work itself.
 */
export function isSettledExchangeEntry(entry: TurnWorkStreamEntry): boolean {
  return entry.kind === "follow-up" || entry.kind === "sent-message"
    || entry.kind === "html-render" || entry.kind === "subagent-call" || entry.kind === "secret-request"
    || (entry.kind === "subagent-group" && !entry.foldable)
    || (entry.kind === "commentary" && entry.answer === true);
}

function mergeChronologically(
  stream: TurnWorkStreamEntry[],
  pending: TurnWorkStreamEntry[],
): TurnWorkStreamEntry[] {
  const merged: TurnWorkStreamEntry[] = [];
  let pendingIndex = 0;
  for (const entry of stream) {
    while (
      pendingIndex < pending.length
      && compareTimestamps(pending[pendingIndex]!.createdAt, entry.createdAt) <= 0
    ) {
      merged.push(pending[pendingIndex]!);
      pendingIndex += 1;
    }
    merged.push(entry);
  }
  while (pendingIndex < pending.length) {
    merged.push(pending[pendingIndex]!);
    pendingIndex += 1;
  }
  return merged;
}

export function withHtmlRenders(
  stream: TurnExecutionStreamEntry[],
  renders: ChatMessage[],
): TurnWorkStreamEntry[] {
  if (renders.length === 0) return stream;
  return mergeChronologically(stream, renders.map((message) => ({
    kind: "html-render" as const,
    id: `html-render:${message.id}`,
    createdAt: message.createdAt,
    message,
  })));
}

export interface LiveTextFollowUps {
  segment: number;
  known: string[];
  held: string[];
}

export function trackLiveTextFollowUps(
  tracked: LiveTextFollowUps | null,
  turn: Pick<ResponseTurn, "followUpMessages" | "commentaryMessages">,
): LiveTextFollowUps {
  const ids = turn.followUpMessages.map(({ id }) => id);
  const segment = turn.commentaryMessages.length;
  if (tracked?.segment !== segment) return { segment, known: ids, held: [] };
  const fresh = ids.filter((id) => !tracked.known.includes(id));
  return fresh.length === 0
    ? tracked
    : { segment, known: [...tracked.known, ...fresh], held: [...tracked.held, ...fresh] };
}

const LIVE_SEGMENT_MIN_OVERLAP = 24;

export function continuedLiveSegment(persisted: string, live: string): string | null {
  if (!persisted) return null;
  if (live.startsWith(persisted)) return live;
  const probe = live.slice(0, LIVE_SEGMENT_MIN_OVERLAP);
  for (
    let at = probe.length < LIVE_SEGMENT_MIN_OVERLAP ? -1 : persisted.indexOf(probe, 1);
    at > 0;
    at = persisted.indexOf(probe, at + 1)
  ) {
    if (live.startsWith(persisted.slice(at))) return persisted.slice(0, at) + live;
  }
  return null;
}

export function liveSegmentContinuation(
  turn: Pick<ResponseTurn, "isActive" | "terminalAssistantMessage" | "commentaryMessages" | "activities">,
  live: string,
): string | null {
  const latest = turn.isActive && !turn.terminalAssistantMessage && live
    ? turn.commentaryMessages.at(-1)
    : undefined;
  return latest && !turn.activities.some(({ createdAt }) => compareTimestamps(createdAt, latest.createdAt) > 0)
    ? continuedLiveSegment(latest.content, live)
    : null;
}

export function withLiveCommentary(
  stream: TurnWorkStreamEntry[],
  live: Extract<TurnExecutionStreamEntry, { kind: "commentary" }>,
  heldFollowUpIds: string[],
): TurnWorkStreamEntry[] {
  const held = stream.findIndex((entry) =>
    entry.kind === "follow-up" && heldFollowUpIds.includes(entry.id));
  return held < 0
    ? [...stream, live]
    : [...stream.slice(0, held), live, ...stream.slice(held)];
}

export function followUpAnswers(
  turn: Pick<ResponseTurn, "followUpMessages" | "commentaryMessages">,
): Set<ChatMessage> {
  const answers = new Set<ChatMessage>();
  if (turn.followUpMessages.length === 0 || turn.commentaryMessages.length === 0) {
    return answers;
  }
  for (const followUp of turn.followUpMessages) {
    let answer: ChatMessage | undefined;
    for (const message of turn.commentaryMessages) {
      if (compareTimestamps(message.createdAt, followUp.createdAt) <= 0) answer = message;
    }
    if (answer) answers.add(answer);
  }
  return answers;
}

interface BuildTurnExecutionStreamOptions {
  liveContent?: string;
  includeImportantActivities?: boolean;
  includeCompactions?: boolean;
}

/**
 * Builds the visible provider transcript in event order. Only adjacent work
 * entries are grouped; commentary and follow-ups always break a group.
 */
export function buildTurnExecutionStream(
  turn: Pick<
    ResponseTurn,
    "id" | "agentTurn" | "followUpMessages" | "commentaryMessages" | "activities"
  > & Partial<Pick<ResponseTurn, "sentMessages" | "secretRequests">>,
  options: BuildTurnExecutionStreamOptions = {},
): TurnExecutionStreamEntry[] {
  const includeImportant = options.includeImportantActivities ?? true;
  const answers = followUpAnswers(turn);
  const items: Array<
    | {
        kind: "commentary";
        id: string;
        createdAt: string;
        message: ChatMessage | null;
        content: string;
        streaming: boolean;
        answer?: true;
        order: number;
      }
    | {
        kind: "follow-up";
        id: string;
        createdAt: string;
        message: ChatMessage;
        order: number;
      }
    | {
        kind: "sent-message";
        id: string;
        createdAt: string;
        message: SentToUserMessage;
        order: number;
      }
    | {
        kind: "secret-request";
        id: string;
        createdAt: string;
        message: SecretRequestMessage;
        order: number;
      }
    | {
        kind: "activity" | "compaction";
        id: string;
        createdAt: string;
        activity: AgentActivity;
        order: number;
        episode: number;
      }
  > = [];

  for (const message of turn.commentaryMessages) {
    items.push({
      kind: "commentary",
      id: message.id,
      createdAt: message.createdAt,
      message,
      content: message.content,
      streaming: false,
      ...(answers.has(message) ? { answer: true as const } : {}),
      order: 0,
    });
  }
  for (const message of turn.followUpMessages) {
    items.push({
      kind: "follow-up",
      id: message.id,
      createdAt: message.createdAt,
      message,
      order: 1,
    });
  }
  // A message is stored while its tool call runs, so on a tie it follows the
  // call's activity, and like prose it ends the work group before it.
  for (const message of turn.sentMessages ?? []) {
    items.push({
      kind: "sent-message",
      id: `sent-message:${message.id}`,
      createdAt: message.createdAt,
      message,
      order: 3,
    });
  }
  for (const message of turn.secretRequests ?? []) {
    items.push({
      kind: "secret-request",
      id: `secret-request:${message.secretRequest.requestId}`,
      createdAt: message.createdAt,
      message,
      order: 3,
    });
  }
  let episode = 0;
  let previousCompaction: AgentActivity | null = null;
  for (const activity of turn.activities) {
    const compaction = isCompactionActivity(activity);
    if (compaction && (
      !previousCompaction
      || (previousCompaction.status !== "running" && activity.status === "running")
    )) episode += 1;
    previousCompaction = compaction ? activity : null;
    if (compaction ? !options.includeCompactions : !isTranscriptActivity(activity)) continue;
    if (!includeImportant && activityNeedsAttention(activity)) continue;
    items.push({
      kind: compaction ? "compaction" : "activity",
      id: activity.id,
      createdAt: activity.createdAt,
      activity,
      order: 2,
      episode: compaction ? episode : 0,
    });
  }
  if (options.liveContent) {
    items.push({
      kind: "commentary",
      id: `live-commentary:${turn.id}`,
      createdAt: turn.agentTurn.updatedAt,
      message: null,
      content: options.liveContent,
      streaming: true,
      order: 3,
    });
  }
  items.sort((left, right) =>
    Number(left.kind === "commentary" && left.streaming)
      - Number(right.kind === "commentary" && right.streaming)
    || compareTimestamps(left.createdAt, right.createdAt)
    || left.order - right.order
    || EN_COLLATOR.compare(left.id, right.id));

  const stream: TurnExecutionStreamEntry[] = [];
  let streamEpisode = 0;
  for (const item of items) {
    if (
      item.kind === "commentary"
      || item.kind === "follow-up"
      || item.kind === "sent-message"
      || item.kind === "secret-request"
    ) {
      stream.push(item);
      continue;
    }
    const kind = item.kind === "compaction" ? "compaction" : "activity-group";
    const previous = stream.at(-1);
    if (previous?.kind === kind && (kind !== "compaction" || item.episode === streamEpisode)) {
      previous.activities.push(item.activity);
      continue;
    }
    streamEpisode = item.episode;
    stream.push({
      kind,
      id: `${kind}:${item.id}`,
      createdAt: item.createdAt,
      activities: [item.activity],
    });
  }
  return stream;
}
