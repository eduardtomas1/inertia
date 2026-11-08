import {
  MAX_DELEGATED_RESULT_BYTES,
  MAX_DELEGATED_RESULT_PREVIEW_CHARS,
  MAX_DELEGATED_WAKE_BYTES,
  type DelegatedTaskStatus,
} from "../../shared/orchestration-delegation";
import { byteLength } from "../persistence/bounded-message-text";
import { boundedUntrustedAgentText, neutralizeUntrustedAgentText, truncateUtf8 } from "../runtime/untrusted-agent-text";

export interface DelegatedWakeEntry {
  taskId: string;
  title: string;
  status: DelegatedTaskStatus;
  text: string | null;
}

export interface DelegatedWakeCohort {
  total: number;
}

const SINGLE_VERBS: Record<DelegatedTaskStatus, string> = {
  running: "is still running",
  completed: "finished",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "was interrupted",
};

const BATCH_VERBS: Record<DelegatedTaskStatus, string> = {
  running: "are still running",
  completed: "finished",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "were interrupted",
};

const OUTCOME_PRECEDENCE: readonly DelegatedTaskStatus[] = ["failed", "cancelled", "interrupted", "running", "completed"];
const NOTICE_LABEL_MAX_CHARS = 80;

export function delegatedTaskLabel(title: string): string {
  const line = neutralizeUntrustedAgentText(title.replace(/\s+/gu, " ").trim());
  const bounded = truncateUtf8(line, 480).text;
  return bounded || "Untitled task";
}

export function delegatedResultText(value: string | null): { text: string | null; truncated: boolean; neutralized: boolean } {
  if (value === null) return { text: null, truncated: false, neutralized: false };
  return boundedUntrustedAgentText(value, MAX_DELEGATED_RESULT_BYTES);
}

export function delegatedResultPreview(value: string | null): string | null {
  if (value === null) return null;
  const text = neutralizeUntrustedAgentText(value).replace(/\s+/gu, " ").trim();
  if (!text) return null;
  const characters = Array.from(text);
  return characters.length > MAX_DELEGATED_RESULT_PREVIEW_CHARS
    ? `${characters.slice(0, MAX_DELEGATED_RESULT_PREVIEW_CHARS - 1).join("")}…` : text;
}

export function delegatedNoticeLabel(title: string): string {
  const characters = Array.from(delegatedTaskLabel(title));
  return characters.length > NOTICE_LABEL_MAX_CHARS
    ? `${characters.slice(0, NOTICE_LABEL_MAX_CHARS - 1).join("")}…` : characters.join("");
}

export function delegatedDeliveryOutcome(statuses: readonly DelegatedTaskStatus[]): DelegatedTaskStatus {
  return OUTCOME_PRECEDENCE.find((status) => statuses.includes(status)) ?? "completed";
}

export function delegatedWakeSummary(entries: readonly Pick<DelegatedWakeEntry, "title" | "status">[], cohort: DelegatedWakeCohort): string {
  const [only] = entries;
  if (entries.length === 1 && only) return `Delegated task "${delegatedNoticeLabel(only.title)}" ${SINGLE_VERBS[only.status]}`;
  const count = cohort.total > entries.length ? `${entries.length} of ${cohort.total}` : `${entries.length}`;
  const verb = BATCH_VERBS[delegatedDeliveryOutcome(entries.map(({ status }) => status))];
  const labels = entries.map(({ title }) => delegatedNoticeLabel(title));
  return `${count} delegated tasks ${verb}${labels.length ? `: ${labels.join(", ")}` : ""}`;
}

export function delegatedWakeText(entries: readonly DelegatedWakeEntry[], cohort: DelegatedWakeCohort): string {
  const summary = delegatedWakeSummary(entries, cohort);
  const parts = [summary];
  let used = byteLength(summary);
  const fallbacks = entries.map((entry) => `${header(entry)}\nUse inertia_get_task_status with taskId ${entry.taskId} to read the result.`);
  const reserved = (from: number) => fallbacks.slice(from).reduce((total, line) => total + byteLength(line) + 2, 0);
  for (const [index, entry] of entries.entries()) {
    const result = delegatedResultText(entry.text);
    const block = `${header(entry)}\n${result.text?.trim() || "(No result text.)"}${result.truncated ? "\n[Result truncated.]" : ""}`;
    const remaining = MAX_DELEGATED_WAKE_BYTES - used - reserved(index + 1);
    const chosen = byteLength(block) + 2 <= remaining ? block : fallbacks[index]!;
    parts.push(chosen);
    used += byteLength(chosen) + 2;
  }
  return truncateUtf8(parts.join("\n\n"), MAX_DELEGATED_WAKE_BYTES).text;
}

function header(entry: DelegatedWakeEntry): string {
  return `Delegated task ${entry.taskId} (${delegatedTaskLabel(entry.title)}) [${entry.status}]:`;
}
