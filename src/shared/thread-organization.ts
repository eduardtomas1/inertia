import type { Conversation, WorkspaceRun } from "./contracts";

export function canOrganizeThread(conversation: Conversation, runs: readonly WorkspaceRun[]): boolean {
  return conversation.status !== "running" && conversation.status !== "needs-input"
    && !runs.some((run) => run.conversationId === conversation.id
      && (run.status === "running" || run.status === "waiting"));
}

/** Calendar presets use local dates, not 24-hour arithmetic across DST. */
export function threadSnoozePresets(now: Date): Array<{ id: string; label: string; until: string }> {
  const hour = 60 * 60 * 1000;
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7));
  nextWeek.setHours(9, 0, 0, 0);
  const presets = [
    { id: "hour", label: "In 1 hour", date: new Date(now.getTime() + hour) },
    { id: "three-hours", label: "In 3 hours", date: new Date(now.getTime() + 3 * hour) },
    ...(evening > now ? [{ id: "evening", label: "This evening", date: evening }] : []),
    { id: "tomorrow", label: "Tomorrow", date: tomorrow },
    { id: "next-week", label: "Next week", date: nextWeek },
  ];
  return presets.map(({ id, label, date }) => ({
    id,
    label: `${label} (${date.toLocaleString(undefined, {
      ...(id === "next-week" ? { weekday: "short" } : {}), hour: "numeric", minute: "2-digit",
    })})`,
    until: date.toISOString(),
  }));
}
