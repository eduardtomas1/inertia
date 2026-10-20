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
  "wake-budget": "It used its checks for this turn. Resume grants a new set.",
  "usage-limit": "Its account reached a usage limit. It can resume once its route is ready.",
  "write-detected": "Files changed that no running agent accounts for.",
  "write-attempts": "It tried to edit a file twice during one turn.",
  "route-unavailable": "Its route is unavailable. Check Settings → Agents.",
  "watched-archived": "The watched chat was archived.",
};

export function watcherPauseText(reason: WatcherPauseReason | null, detail: string | null): string {
  const base = reason ? WATCHER_PAUSE_REASON_TEXT[reason] : "Paused.";
  return detail && reason !== "write-detected" ? `${base} ${detail}` : base;
}

export function watcherPauseAnnouncement(reason: WatcherPauseReason | null): string {
  const text = reason ? WATCHER_PAUSE_REASON_TEXT[reason] : "";
  return `Paused: ${text || "the watcher is paused."}`;
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
  starting: "Starting the check",
  reading: "Reading",
  searching: "Searching",
  thinking: "Thinking",
  writing: "Writing its review",
};

export function watcherPhaseText(phase: WatcherLivePhase, label: string | null): string {
  return label?.trim() || PHASE_TEXT[phase];
}

export function watcherDeliveryText(delivery: WatcherDelivery, watchedRunning: boolean): string {
  if (delivery.state === "queued") {
    return watchedRunning || delivery.mode === "steer"
      ? "Queued · sends after the current turn"
      : "Queued · sends when the main chat is free";
  }
  if (delivery.state === "sent") {
    return delivery.mode === "steer"
      ? "Sent · delivered into the running turn"
      : "Sent · started the main chat's next turn";
  }
  if (delivery.state === "failed") return "Not sent";
  return "Dismissed";
}

export function watcherClockTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString(INTERFACE_LOCALE, { hour: "numeric", minute: "2-digit" });
}
