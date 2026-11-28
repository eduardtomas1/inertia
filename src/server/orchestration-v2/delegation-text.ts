import {
  MAX_DELEGATED_RESULT_BYTES,
  MAX_DELEGATED_RESULT_PREVIEW_CHARS,
  MAX_DELEGATED_WAKE_BYTES,
  type DelegatedTaskStatus,
} from "../../shared/orchestration-delegation";
import { DELEGATED_SINGLE_VERBS, delegatedOutcomeGroups } from "../../shared/delegated-outcome";
import { byteLength } from "../persistence/bounded-message-text";
import { boundedUntrustedAgentText, neutralizeUntrustedAgentText, truncateUtf8 } from "../runtime/untrusted-agent-text";

export interface DelegatedWakeEntry {
  taskId: string;
  title: string;
  status: DelegatedTaskStatus;
  text: string | null;
  childConversationId?: string;
  originalTaskId?: string | null;
}

export interface DelegatedWakeCohort {
  total: number;
}

const NOTICE_LABEL_MAX_CHARS = 80;
/** What a delegated result without report text reads as. */
export const DELEGATED_NO_RESULT_TEXT = "(No result text.)";
/** The share of the result bound a provider stop reason keeps, so a long report cannot push it out. */
const MAX_DELEGATED_STOP_REASON_BYTES = 2_000;

export function delegatedTaskLabel(title: string): string {
  const line = neutralizeUntrustedAgentText(title.replace(/\s+/gu, " ").trim());
  const bounded = truncateUtf8(line, 480).text;
  return bounded || "Untitled task";
}

/**
 * A delegated result, bounded and neutralized. A provider stop reason ends every result that has one (T3
 * `withStopNotice`, `c440fd19d`): after the report, or after the no-text marker, separated by a blank line.
 */
export function delegatedResultText(value: string | null, stopReason?: string | null): {
  text: string | null; truncated: boolean; neutralized: boolean;
} {
  if (!stopReason) {
    return value === null ? { text: null, truncated: false, neutralized: false }
      : boundedUntrustedAgentText(value, MAX_DELEGATED_RESULT_BYTES);
  }
  const reason = boundedUntrustedAgentText(stopReason, MAX_DELEGATED_STOP_REASON_BYTES);
  const report = boundedUntrustedAgentText(value ?? DELEGATED_NO_RESULT_TEXT,
    MAX_DELEGATED_RESULT_BYTES - byteLength(reason.text) - 2);
  return { text: `${report.text}\n\n${reason.text}`, truncated: report.truncated || reason.truncated,
    neutralized: report.neutralized || reason.neutralized };
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

export function delegatedWakeSummary(entries: readonly Pick<DelegatedWakeEntry, "title" | "status">[], cohort: DelegatedWakeCohort): string {
  const [only] = entries;
  if (entries.length === 1 && only) return `Delegated task "${delegatedNoticeLabel(only.title)}" ${DELEGATED_SINGLE_VERBS[only.status]}`;
  const count = cohort.total > entries.length ? `${entries.length} of ${cohort.total}` : `${entries.length}`;
  const labels = entries.map(({ title }) => delegatedNoticeLabel(title));
  return `${count} delegated tasks ${delegatedOutcomeGroups(entries.map(({ status }) => status))}${labels.length
    ? `: ${labels.join(", ")}` : ""}`;
}

export function delegatedWakeText(entries: readonly DelegatedWakeEntry[], cohort: DelegatedWakeCohort): string {
  const summary = delegatedWakeSummary(entries, cohort);
  const parts = [summary];
  let used = byteLength(summary);
  const fallbacks = entries.map((entry) => `${header(entry)}\nUse inertia_get_task_status with taskId ${entry.taskId} to read the result.`);
  const reserved = (from: number) => fallbacks.slice(from).reduce((total, line) => total + byteLength(line) + 2, 0);
  for (const [index, entry] of entries.entries()) {
    const result = delegatedResultText(entry.text);
    const block = `${header(entry)}\n${result.text?.trim() || DELEGATED_NO_RESULT_TEXT}${result.truncated ? "\n[Result truncated.]" : ""}`;
    const remaining = MAX_DELEGATED_WAKE_BYTES - used - reserved(index + 1);
    const chosen = byteLength(block) + 2 <= remaining ? block : fallbacks[index]!;
    parts.push(chosen);
    used += byteLength(chosen) + 2;
  }
  return truncateUtf8(parts.join("\n\n"), MAX_DELEGATED_WAKE_BYTES).text;
}

function sanitizeHeaderToken(value: string | null | undefined): string {
  if (!value) return "";
  const cleaned = neutralizeUntrustedAgentText(value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim());
  return truncateUtf8(cleaned, 128).text;
}

function header(entry: DelegatedWakeEntry): string {
  const details = [delegatedTaskLabel(entry.title)];
  const childId = sanitizeHeaderToken(entry.childConversationId);
  if (childId) details.push(`chat ${childId}`);
  const originalTaskId = sanitizeHeaderToken(entry.originalTaskId);
  if (originalTaskId) details.push(`follow-up of ${originalTaskId}`);
  return `Delegated task ${entry.taskId} (${details.join(", ")}) [${entry.status}]:`;
}
