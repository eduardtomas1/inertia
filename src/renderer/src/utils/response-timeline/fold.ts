import { followUpAnswers, isTranscriptActivity } from "./execution";
import type { ResponseTurn } from "./model";
import { formatElapsed, turnExecutionElapsedMs } from "./timing";

export function shouldFoldSettledTurn(
  turn: Pick<ResponseTurn, "isActive" | "agentTurn" | "approvals" | "inputRequests">,
): boolean {
  if (turn.isActive || turn.approvals.length > 0 || turn.inputRequests.length > 0) {
    return false;
  }
  const { status } = turn.agentTurn;
  return status === "completed" || status === "cancelled" || status === "interrupted";
}

export function turnHasFoldableWork(
  turn: Pick<
    ResponseTurn,
    "foldableActivities" | "commentaryMessages" | "followUpMessages" | "plans" | "reasoning"
  >,
  options: { showThinking: boolean },
): boolean {
  if (turn.plans.length > 0) return true;
  if (options.showThinking && Boolean(turn.reasoning?.content)) return true;
  if (turn.foldableActivities.some(isTranscriptActivity)) return true;
  if (turn.commentaryMessages.length === 0) return false;
  const answers = followUpAnswers(turn);
  return turn.commentaryMessages.some((message) => !answers.has(message));
}

export function turnFoldLabel(
  turn: Pick<ResponseTurn, "startedAt" | "completedAt" | "isActive" | "agentTurn">,
  now = Date.now(),
): string {
  const execution = turnExecutionElapsedMs(turn, now);
  const duration = execution === null ? null : formatElapsed(execution);
  const stopped = turn.agentTurn.status === "cancelled" || turn.agentTurn.status === "interrupted";
  if (stopped) return duration ? `Stopped after ${duration}` : "Stopped";
  return duration ? `Worked for ${duration}` : "Worked";
}

export function isQuietSettledTurn(
  turn: Pick<
    ResponseTurn,
    | "isActive"
    | "agentTurn"
    | "approvals"
    | "inputRequests"
    | "importantActivities"
    | "followUpMessages"
    | "systemMessages"
    | "terminalAssistantMessage"
  >,
  foldVisible: boolean,
): boolean {
  return !foldVisible
    && shouldFoldSettledTurn(turn)
    && !needsStaticFoldRow(turn, foldVisible)
    && turn.importantActivities.length === 0
    && turn.followUpMessages.length === 0
    && turn.systemMessages.length === 0;
}

export function needsStaticFoldRow(
  turn: Pick<ResponseTurn, "isActive" | "agentTurn" | "terminalAssistantMessage">,
  foldVisible: boolean,
): boolean {
  return !foldVisible
    && !turn.isActive
    && turn.agentTurn.status === "completed"
    && turn.terminalAssistantMessage === null;
}
