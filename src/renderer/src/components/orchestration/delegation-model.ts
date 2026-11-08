import type { Conversation, ServerEvent } from "@shared/contracts";
import type { ConversationDelegation, DelegatedTaskStatus, DelegatedTaskSummary } from "@shared/orchestration-delegation";
import type { ObservedChildThread, ObservedChildUsage } from "@shared/observed-child-thread";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { agentRequestProviderName } from "../../utils/agentInput";

export type DelegationCommand = Extract<CommandWithoutId, {
  type: "delegation.task.cancel" | "delegation.delivery.dismiss" | "delegation.delivery.send" | "delegation.wake.set"
    | "delegation.task.read" | "observed-child.read" | "agent.subagent.stop";
}>;
export type DelegationCommandRunner = (key: string, command: DelegationCommand,
  options?: { reportError?: boolean }) => Promise<ServerEvent>;
export type ObservedChildCommandRunner = DelegationCommandRunner;

export interface DelegationActions {
  conversationId: string;
  run: DelegationCommandRunner | undefined;
  openConversation: ((conversationId: string) => boolean) | undefined;
}

export interface DelegationSurface extends DelegationActions {
  delegation: ConversationDelegation | undefined;
  conversations: readonly Pick<Conversation, "id" | "title">[] | undefined;
}

export type ChipTone = "working" | "attention" | "ready" | "settled";
export interface TaskChip { label: string; tone: ChipTone }

const RESULT_LABELS: Record<string, string> = {
  completed: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", running: "Running",
};

export function taskOutcomeLabel(status: DelegatedTaskSummary["status"]): string {
  return RESULT_LABELS[status] ?? status;
}

export function isUndelivered(task: Pick<DelegatedTaskSummary, "status" | "delivery">): boolean {
  const state = task.delivery.state;
  return task.status !== "running" && (state === null || state === "pending");
}

const NEEDS_YOU: Record<NonNullable<DelegatedTaskSummary["needsAction"]>["kind"], string> = {
  question: "Needs your answer", approval: "Needs your approval",
};

export function taskChip(task: Pick<DelegatedTaskSummary, "status" | "workState" | "delivery" | "needsAction">): TaskChip {
  if (task.status === "running") {
    if (task.needsAction) return { label: NEEDS_YOU[task.needsAction.kind], tone: "attention" };
    if (task.workState === "waiting_for_children") return { label: "Waiting for its own agents", tone: "working" };
    return { label: "Working", tone: "working" };
  }
  const state = task.delivery.state;
  if (state === "delivered" || state === "acknowledged") return { label: "Delivered", tone: "settled" };
  if (state === "disposed") return { label: "Dismissed", tone: "settled" };
  return { label: "Result ready", tone: "ready" };
}

export function wakeLabel(task: Pick<DelegatedTaskSummary, "completionWake" | "wakeArmed">): string {
  if (task.completionWake === "never") return "No automatic continue";
  return task.wakeArmed ? "Will continue this chat" : "Waits for you";
}

export function wakeAdjustable(task: Pick<DelegatedTaskSummary, "completionWake" | "status" | "delivery">): boolean {
  return task.completionWake !== "never" && (task.status === "running" || isUndelivered(task));
}

export function routeLabel(route: DelegatedTaskSummary["route"]): string {
  const model = route.modelId === "provider-default" ? null : route.modelId;
  return [agentRequestProviderName(route.providerId), model, route.reasoningEffort].filter(Boolean).join(" · ");
}

export function delegationTaskRows(delegation: ConversationDelegation | undefined): DelegatedTaskSummary[] {
  const byId = new Map<string, DelegatedTaskSummary>();
  for (const task of delegation?.asParent?.tasks ?? []) {
    const known = byId.get(task.taskId);
    if (!known || known.updatedAt.localeCompare(task.updatedAt, "en") <= 0) byId.set(task.taskId, task);
  }
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt, "en")
    || left.taskId.localeCompare(right.taskId, "en"));
}

export function childStatusLabel(asChild: NonNullable<ConversationDelegation["asChild"]>): string {
  if (asChild.status === "running") {
    return taskChip({ status: "running", workState: asChild.workState, delivery: { state: null, generation: null } }).label;
  }
  return taskOutcomeLabel(asChild.status);
}

const SINGLE_VERBS: Record<DelegatedTaskStatus, string> = {
  running: "is still running", completed: "finished", failed: "failed", cancelled: "stopped", interrupted: "was interrupted",
};
const BATCH_VERBS: Record<DelegatedTaskStatus, string> = {
  running: "are still running", completed: "finished", failed: "failed", cancelled: "stopped", interrupted: "were interrupted",
};
const OUTCOME_PRECEDENCE: readonly DelegatedTaskStatus[] = ["failed", "cancelled", "interrupted", "running", "completed"];
const NOTICE_LABEL_MAX_CHARS = 80;
const SINGLE_LINE = /^Delegated task "(.+)" (finished|failed|stopped|was interrupted|is still running)$/u;
const BATCH_LINE = /^(\d+)(?: of (\d+))? delegated tasks (finished|failed|stopped|were interrupted|are still running)(?:: (.+))?$/u;
const TASK_HEADER = /^Delegated task ([0-9a-f]{64}) \((.*)\) \[(running|completed|failed|cancelled|interrupted)\]:$/u;

export interface CompletionTask {
  taskId: string;
  label: string | null;
  status: DelegatedTaskStatus | null;
  summary: DelegatedTaskSummary | null;
}

export interface CompletionSummary {
  title: string;
  headline: string;
  labels: string | null;
  tasks: CompletionTask[];
}

function noticeLabel(title: string): string {
  const characters = Array.from(title.replace(/\s+/gu, " ").trim() || "Untitled task");
  return characters.length > NOTICE_LABEL_MAX_CHARS
    ? `${characters.slice(0, NOTICE_LABEL_MAX_CHARS - 1).join("")}…` : characters.join("");
}

function deliveredStatuses(content: string, taskIds: readonly string[]): Map<string, { label: string; status: DelegatedTaskStatus }> {
  const statuses = new Map<string, { label: string; status: DelegatedTaskStatus }>();
  let next = 0;
  for (const line of content.split("\n")) {
    if (next >= taskIds.length) break;
    const match = TASK_HEADER.exec(line);
    if (!match || match[1] !== taskIds[next]) continue;
    statuses.set(match[1], { label: match[2]!, status: match[3] as DelegatedTaskStatus });
    next += 1;
  }
  return statuses;
}

function parsedHeadline(line: string, count: number): Pick<CompletionSummary, "headline" | "labels"> | null {
  if (SINGLE_LINE.test(line)) return count === 1 ? { headline: line, labels: null } : null;
  const batch = BATCH_LINE.exec(line);
  if (!batch || Number(batch[1]) !== count || count < 2) return null;
  if (batch[2] !== undefined && Number(batch[2]) <= count) return null;
  return { headline: `${batch[1]}${batch[2] ? ` of ${batch[2]}` : ""} delegated tasks ${batch[3]}`, labels: batch[4] ?? null };
}

export function completionSummary(taskIds: readonly string[], delegation: ConversationDelegation | undefined,
  content = ""): CompletionSummary {
  const rows = delegationTaskRows(delegation);
  const unique = [...new Set(taskIds)];
  const delivered = deliveredStatuses(content, unique);
  const tasks = unique.map((taskId): CompletionTask => {
    const summary = rows.find((row) => row.taskId === taskId) ?? null;
    const payload = delivered.get(taskId);
    const settled = summary && summary.status !== "running" ? summary.status : null;
    return { taskId, summary, label: summary?.title ?? payload?.label ?? null, status: settled ?? payload?.status ?? summary?.status ?? null };
  });
  const parsed = parsedHeadline(content.split("\n", 1)[0]?.trim() ?? "", unique.length);
  if (parsed) return { ...parsed, title: parsed.labels ? `${parsed.headline}: ${parsed.labels}` : parsed.headline, tasks };
  const statuses = tasks.flatMap(({ status }) => status ? [status] : []);
  const outcome = OUTCOME_PRECEDENCE.find((status) => statuses.includes(status)) ?? "completed";
  const [only] = tasks;
  if (tasks.length === 1 && only?.label) {
    const headline = `Delegated task "${noticeLabel(only.label)}" ${SINGLE_VERBS[only.status ?? outcome]}`;
    return { title: headline, headline, labels: null, tasks };
  }
  const sources = new Set(tasks.flatMap(({ summary }) => summary ? [summary.sourceTurnId] : []));
  const cohort = rows.filter((row) => sources.has(row.sourceTurnId) || unique.includes(row.taskId)).length;
  const total = Math.max(unique.length, cohort);
  const count = total > unique.length ? `${unique.length} of ${total}` : `${unique.length}`;
  const headline = `${count} delegated ${unique.length === 1 ? "task" : "tasks"} ${(unique.length === 1 ? SINGLE_VERBS : BATCH_VERBS)[outcome]}`;
  const known = tasks.flatMap(({ label }) => label ? [noticeLabel(label)] : []);
  const labels = known.length === tasks.length && known.length > 0 ? known.join(", ") : null;
  return { title: labels ? `${headline}: ${labels}` : headline, headline, labels, tasks };
}

const OBSERVED_STATUS: Record<string, string> = {
  queued: "Queued", spawned: "Starting", running: "Running", waiting: "Waiting", completed: "Completed",
  failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", unknown: "Unknown", lost: "Lost",
};

export function observedStatusLabel(status: ObservedChildThread["status"]): string {
  return OBSERVED_STATUS[status] ?? status;
}

export function observedName(child: Pick<ObservedChildThread, "name" | "role" | "description">): string {
  return child.name ?? child.role ?? child.description?.split("\n")[0]?.slice(0, 80) ?? "Agent";
}

export function observedLineage(child: ObservedChildThread, children: readonly ObservedChildThread[]): ObservedChildThread[] {
  const byId = new Map(children.map((entry) => [entry.id, entry]));
  const chain: ObservedChildThread[] = [child];
  let parentId = child.parent.parentTraceId;
  while (parentId && chain.length < 8) {
    const parent = byId.get(parentId);
    if (!parent || chain.includes(parent)) break;
    chain.unshift(parent);
    parentId = parent.parent.parentTraceId;
  }
  return chain;
}

export function usageLabel(usage: ObservedChildUsage | null, toolUseCount: number | null): string | null {
  const parts: string[] = [];
  const total = usage?.totalTokens ?? (usage && usage.inputTokens !== null && usage.outputTokens !== null
    ? usage.inputTokens + usage.outputTokens : null);
  if (total !== null) parts.push(`${total.toLocaleString("en-US")} tokens`);
  if (toolUseCount !== null) parts.push(`${toolUseCount} ${toolUseCount === 1 ? "tool use" : "tool uses"}`);
  return parts.length ? parts.join(" · ") : null;
}

export function failureText(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}
