import type { MascotPhase } from "../../../shared/mascot";

export function mascotActionLabel(phase: MascotPhase): string {
  if (phase === "waiting-for-input") return "Answer in chat ↗";
  if (phase === "waiting-for-approval") return "Review approval ↗";
  if (phase === "completed") return "View result ↗";
  if (phase === "failed" || phase === "interrupted") return "View issue ↗";
  return "Open chat ↗";
}

export const mascotShortLabel: Record<MascotPhase, string> = {
  idle: "Idle",
  unavailable: "Offline",
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  delegated: "Delegated",
  retrying: "Retrying",
  "waiting-for-input": "Needs you",
  "waiting-for-approval": "Needs you",
  cancelling: "Stopping",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Stopped",
};

export type MascotTone = "attention" | "live" | "done" | "problem" | "quiet";

export function mascotTone(phase: MascotPhase): MascotTone {
  if (phase === "waiting-for-input" || phase === "waiting-for-approval") return "attention";
  if (phase === "completed") return "done";
  if (phase === "failed" || phase === "interrupted") return "problem";
  if (phase === "idle" || phase === "unavailable" || phase === "cancelled") return "quiet";
  return "live";
}

export function mascotElapsed(since: string, now: number, live: boolean): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (live) {
    if (minutes < 1) return "<1m";
    if (minutes < 60) return `${minutes}m`;
    return hours < 24 ? `${hours}h ${minutes % 60}m` : `${days}d ${hours % 24}h`;
  }
  if (minutes < 1) return "just now";
  return `${minutes < 60 ? `${minutes}m` : hours < 24 ? `${hours}h` : `${days}d`} ago`;
}
