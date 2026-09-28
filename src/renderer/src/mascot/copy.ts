import type { MascotPhase } from "../../../shared/mascot";

export const mascotFallback: Record<MascotPhase, string> = {
  idle: "Start a chat in Inertia. I’ll keep you posted here and let you know when I need you.",
  unavailable: "I’m reconnecting to your workspace. Open Inertia to check the connection.",
  queued: "Your request is in the queue. I’ll show the next update when work starts.",
  starting: "Getting the agent ready for this chat. Its next update will appear here.",
  running: "The agent is working on this chat. Open it to follow the full activity.",
  delegated: "The agent has delegated part of this task. Open the chat to follow its progress.",
  retrying: "The agent is retrying this task. Open the chat for the latest details.",
  "waiting-for-input": "I need your answer before continuing. Open the chat to see the question.",
  "waiting-for-approval": "An action needs your approval. Review its details in the chat to continue.",
  cancelling: "Stopping this task and waiting for the agent to finish cleaning up.",
  completed: "The agent finished this task. Open the chat to read the result and review the changes.",
  failed: "This task hit a problem. Open the chat to see what happened and continue.",
  cancelled: "This task was cancelled. Open the chat to review what happened before it stopped.",
  interrupted: "This task stopped before finishing. Open the chat to review its progress and resume.",
};

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
  "waiting-for-approval": "Approval",
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
