import type {
  WatcherDelivery,
  WatcherLivePhase,
  WatcherPauseReason,
  WatcherWakeOutcome,
  WatcherWakeTrigger,
} from "@shared/watcher";
import { INTERFACE_LOCALE } from "../lib/locale";

/** User-facing watcher copy, shared by the dock and the watcher chat rows. */
export const WATCHER_PAUSE_REASON_TEXT: Readonly<Record<WatcherPauseReason, string>> = {
  user: "You paused it.",
  "wake-budget": "It used its checks for this turn.",
  "usage-limit": "Its account reached a usage limit.",
  "write-detected": "Files changed that no running agent accounts for.",
  "write-attempts": "It tried to edit a file twice during one turn.",
  "route-unavailable": "Its route is unavailable. Check Settings → Agents.",
  "watched-archived": "The watched chat was archived.",
  "watcher-archived": "The watcher chat was archived.",
};

export function watcherPauseText(reason: WatcherPauseReason | null, detail: string | null): string {
  const base = reason ? WATCHER_PAUSE_REASON_TEXT[reason] : "Paused.";
  return detail && reason !== "write-detected" ? detail : base;
}

export function watcherPauseAnnouncement(reason: WatcherPauseReason | null, detail: string | null): string {
  return reason ? `Paused: ${watcherPauseText(reason, detail)}` : "Paused: the watcher is paused.";
}

const OUTCOME_TEXT: Readonly<Record<Exclude<WatcherWakeOutcome, "silent" | "finding">, string>> = {
  failed: "The check failed.",
  cancelled: "The check was cancelled.",
  "usage-limited": "The check stopped at a usage limit.",
  "permission-declined": "The check stopped after a declined permission request.",
  "write-attempt": "The check stopped: the watcher started to edit a file.",
  "command-attempt": "The check stopped: a command needed approval and was declined.",
  "write-detected": "Files changed during the check that no running agent accounts for.",
};

export function watcherOutcomeText(outcome: WatcherWakeOutcome | null): string {
  if (outcome === null) return "Checking now…";
  if (outcome === "silent") return "Nothing to report.";
  if (outcome === "finding") return "Reported a finding.";
  return OUTCOME_TEXT[outcome];
}

const TRIGGER_TEXT: Readonly<Record<WatcherWakeTrigger, string>> = {
  activity: "After new activity",
  plan: "After a plan change",
  error: "After an error",
  "turn-end": "Final check",
  manual: "Check now",
  initial: "Review of the last turn",
};

export function watcherTriggerText(trigger: WatcherWakeTrigger): string {
  return TRIGGER_TEXT[trigger];
}

export { watcherEventsText } from "./watcherLinks";

const PHASE_TEXT: Readonly<Record<WatcherLivePhase, string>> = {
  starting: "Starting",
  reading: "Reading",
  searching: "Searching",
  thinking: "Thinking",
  writing: "Writing its review",
};

export function watcherPhaseText(phase: WatcherLivePhase, label: string | null): string {
  return label?.trim() || PHASE_TEXT[phase];
}

/** A runtime detail as a clause: no trailing period, sentence case folded. */
function detailClause(detail: string | null): string | null {
  const text = detail?.trim().replace(/\.$/u, "").trim();
  if (!text) return null;
  const [first = "", second = ""] = text;
  return second && second === second.toLocaleLowerCase(INTERFACE_LOCALE)
    ? first.toLocaleLowerCase(INTERFACE_LOCALE) + text.slice(1)
    : text;
}

/**
 * One status line for a finding's delivery, built from its state, mode and
 * time. The runtime's detail replaces the default explanation only when it
 * explains something the state does not (a fallback, a later dispatch or a
 * failure reason), and is dropped when it merely repeats the line.
 */
export function watcherDeliveryText(delivery: WatcherDelivery & { automatic?: boolean }, watchedRunning: boolean): string {
  const time = watcherClockTime(delivery.at);
  const head = delivery.state === "queued"
    ? "Queued"
    : delivery.state === "sent"
      ? time ? `Sent ${time}` : "Sent"
      : delivery.state === "failed"
        ? "Not sent"
        : "Dismissed";
  const fallback = delivery.state === "queued"
    ? watchedRunning || delivery.mode === "steer" ? "sends after the current turn" : "sends when the main chat is free"
    : delivery.state === "sent"
      ? delivery.mode === "steer" ? "into the running turn" : "started the main chat's next turn"
      : null;
  const clause = detailClause(delivery.detail);
  const repeats = clause !== null && (
    clause === fallback
    || /^(queued|sent|steered|not sent|dismissed)\b/iu.test(clause)
  );
  const explanation = clause !== null && !repeats ? clause : fallback;
  const automatic = delivery.automatic === true && (delivery.state === "queued" || delivery.state === "sent");
  return [head, automatic ? "automatically" : null, explanation].filter(Boolean).join(" · ");
}

export function watcherClockTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString(INTERFACE_LOCALE, { hour: "numeric", minute: "2-digit" });
}
