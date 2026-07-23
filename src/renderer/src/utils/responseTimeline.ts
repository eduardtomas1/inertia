import type {
  AgentActivity,
  AgentReasoning,
  ChatMessage,
  CheckpointSummary,
  ThreadStatus,
} from "@shared/contracts";

export interface ResponseTurn {
  id: string;
  index: number;
  userMessage: ChatMessage;
  assistantMessages: ChatMessage[];
  systemMessages: ChatMessage[];
  activities: AgentActivity[];
  reasoning: AgentReasoning | null;
  checkpoint: CheckpointSummary | null;
  startedAt: string;
  finishedAt: string | null;
  isActive: boolean;
  toolCallCount: number;
  importantActivities: AgentActivity[];
  foldableActivities: AgentActivity[];
}

export type ResponseTimelineItem =
  | { kind: "turn"; id: string; turn: ResponseTurn }
  | { kind: "message"; id: string; message: ChatMessage }
  | { kind: "activity"; id: string; activities: AgentActivity[] };

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inTurn(createdAt: string, start: number, end: number): boolean {
  const value = timestamp(createdAt);
  return value >= start && value < end;
}

export function activityNeedsAttention(activity: AgentActivity): boolean {
  if (activity.status === "failed" || activity.kind === "error") return true;
  return /\b(?:warning|warned|unsupported|skipped|cancelled|canceled|blocked)\b/iu.test(`${activity.title} ${activity.detail ?? ""}`);
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function turnElapsedMs(turn: Pick<ResponseTurn, "startedAt" | "finishedAt">, now = Date.now()): number {
  const start = timestamp(turn.startedAt);
  const end = turn.finishedAt ? timestamp(turn.finishedAt) : now;
  return Math.max(0, end - start);
}

function latestReasoning(items: AgentReasoning[]): AgentReasoning | null {
  if (items.length === 0) return null;
  const latest = items.at(-1)!;
  if (items.length === 1) return latest;
  return {
    ...latest,
    content: items.map(({ content }) => content).filter(Boolean).join("\n\n"),
    status: items.some(({ status }) => status === "failed")
      ? "failed"
      : items.some(({ status }) => status === "running")
        ? "running"
        : "completed",
  };
}

export function buildResponseTimeline(input: {
  messages: ChatMessage[];
  activities: AgentActivity[];
  reasonings: AgentReasoning[];
  checkpoints: CheckpointSummary[];
  status: ThreadStatus;
  conversationUpdatedAt?: string;
}): ResponseTimelineItem[] {
  const messages = [...input.messages].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
  const users = messages.filter(({ role }) => role === "user");
  const items: ResponseTimelineItem[] = [];

  for (const message of messages) {
    if (message.role !== "user" && !users.some((user) => timestamp(user.createdAt) <= timestamp(message.createdAt))) {
      items.push({ kind: "message", id: message.id, message });
    }
  }

  users.forEach((userMessage, index) => {
    const start = timestamp(userMessage.createdAt);
    const end = index + 1 < users.length ? timestamp(users[index + 1]!.createdAt) : Number.POSITIVE_INFINITY;
    const scopedMessages = messages.filter((message) => message.id !== userMessage.id && inTurn(message.createdAt, start, end));
    const assistantMessages = scopedMessages.filter(({ role }) => role === "assistant");
    const systemMessages = scopedMessages.filter(({ role }) => role === "system");
    const activities = input.activities
      .filter((activity) => inTurn(activity.createdAt, start, end))
      .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
    const reasoning = latestReasoning(
      input.reasonings
        .filter((item) => inTurn(item.createdAt, start, end))
        .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt)),
    );
    const isActive = index === users.length - 1 && (input.status === "running" || input.status === "needs-input");
    const finishCandidates = [
      ...assistantMessages.map(({ createdAt }) => timestamp(createdAt)),
      ...activities.map(({ createdAt }) => timestamp(createdAt)),
      ...(reasoning ? [timestamp(reasoning.createdAt)] : []),
      ...(index === users.length - 1 && input.conversationUpdatedAt ? [timestamp(input.conversationUpdatedAt)] : []),
    ];
    const latest = finishCandidates.length > 0 ? Math.max(...finishCandidates) : start;
    const importantActivities = activities.filter(activityNeedsAttention);
    const foldableActivities = activities.filter((activity) => !activityNeedsAttention(activity));
    const turn: ResponseTurn = {
      id: `turn-${userMessage.id}`,
      index: index + 1,
      userMessage,
      assistantMessages,
      systemMessages,
      activities,
      reasoning,
      checkpoint: input.checkpoints.find((checkpoint) => checkpoint.turnIndex === index + 1) ?? null,
      startedAt: userMessage.createdAt,
      finishedAt: isActive ? null : new Date(latest).toISOString(),
      isActive,
      toolCallCount: activities.filter(({ kind }) => kind === "tool" || kind === "command" || kind === "file").length,
      importantActivities,
      foldableActivities,
    };
    items.push({ kind: "turn", id: turn.id, turn });
  });

  const firstUserAt = users[0] ? timestamp(users[0].createdAt) : Number.POSITIVE_INFINITY;
  const orphanActivities = input.activities.filter((activity) => timestamp(activity.createdAt) < firstUserAt);
  const orphanRuns = new Map<string, AgentActivity[]>();
  for (const activity of orphanActivities) {
    const existing = orphanRuns.get(activity.runId) ?? [];
    existing.push(activity);
    orphanRuns.set(activity.runId, existing);
  }
  for (const [runId, activities] of orphanRuns) {
    items.push({
      kind: "activity",
      id: `activity-${runId}`,
      activities: activities.sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt)),
    });
  }

  return items;
}

export function shouldFollowTimeline(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 120): boolean {
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) return true;
  return Math.max(0, scrollHeight - clientHeight - scrollTop) <= threshold;
}

export function workSummaryLabel(turn: ResponseTurn, now = Date.now()): string {
  const duration = formatElapsed(turnElapsedMs(turn, now));
  const actions = turn.activities.length;
  return actions > 0
    ? `Worked for ${duration} · ${actions} ${actions === 1 ? "action" : "actions"}`
    : `Worked for ${duration}`;
}
