import type {
  AgentActivity,
  ChatMessage,
} from "@shared/contracts";
import {
  activityNeedsAttention,
} from "./activity-attention";
import type { ResponseTurn } from "./model";

export {
  activityAttentionSeverity,
  activityNeedsAttention,
  isInterruptedActivity,
  type ActivityAttentionSeverity,
} from "./activity-attention";

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

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

export function isCompactionActivity(activity: AgentActivity): boolean {
  return activity.kind === "status"
    && /\bcompact/iu.test(activity.title)
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
    }
  | {
      kind: "follow-up";
      id: string;
      createdAt: string;
      message: ChatMessage;
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
  >,
  options: BuildTurnExecutionStreamOptions = {},
): TurnExecutionStreamEntry[] {
  const includeImportant = options.includeImportantActivities ?? true;
  const items: Array<
    | {
        kind: "commentary";
        id: string;
        createdAt: string;
        message: ChatMessage | null;
        content: string;
        streaming: boolean;
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
        kind: "activity" | "compaction";
        id: string;
        createdAt: string;
        activity: AgentActivity;
        order: number;
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
  for (const activity of turn.activities) {
    const compaction = isCompactionActivity(activity);
    if (compaction ? !options.includeCompactions : !isTranscriptActivity(activity)) continue;
    if (!includeImportant && activityNeedsAttention(activity)) continue;
    items.push({
      kind: compaction ? "compaction" : "activity",
      id: activity.id,
      createdAt: activity.createdAt,
      activity,
      order: 2,
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
    ||
    timestamp(left.createdAt) - timestamp(right.createdAt)
    || left.order - right.order
    || left.id.localeCompare(right.id, "en"));

  const stream: TurnExecutionStreamEntry[] = [];
  for (const item of items) {
    if (item.kind === "commentary" || item.kind === "follow-up") {
      stream.push(item);
      continue;
    }
    const kind = item.kind === "compaction" ? "compaction" : "activity-group";
    const previous = stream.at(-1);
    if (previous?.kind === kind) {
      previous.activities.push(item.activity);
      continue;
    }
    stream.push({
      kind,
      id: `${kind}:${item.id}`,
      createdAt: item.createdAt,
      activities: [item.activity],
    });
  }
  return stream;
}
