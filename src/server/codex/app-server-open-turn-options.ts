import type { ProviderGoalSnapshot } from "../provider/contracts";
import type { CodexRunPhase } from "./app-server-config";
import type { CodexRequestFailureRecording } from "./app-server-request-errors";
import type { JsonObject } from "./protocol";
import type { CodexAppServerOptions, CodexAppServerResult } from "./types";

/** What `openCodexTurn` needs from its run. */
export interface OpenCodexTurnOptions {
  options: CodexAppServerOptions;
  modelProvider: CodexAppServerOptions["modelProvider"];
  request: (
    method: string,
    params: JsonObject,
    onResponseFrame?: (result?: JsonObject) => void,
    recordFailure?: CodexRequestFailureRecording,
  ) => Promise<JsonObject>;
  notify: (method: string, params?: JsonObject) => void;
  setProviderThreadId: (threadId: string) => void;
  activeTurnId: () => string | undefined;
  setActiveTurnId: (turnId: string | undefined) => void;
  setRequestedTurnId?: (turnId: string | null | undefined) => void;
  replayPreResponseTurnNotifications?: (turnId: string) => void;
  /** A turn Codex started on its own, e.g. a goal continued on resume: held, adopted by a goal start, or stopped. */
  goalTurns?: { held: () => boolean; adopt: () => void; settle: () => Promise<void> };
  phase: () => CodexRunPhase;
  hasObservedTurn: (turnId: string) => boolean;
  goalProjectionSequence: () => number;
  beginGoalMutation: (activatesGoal: boolean) => void;
  endGoalMutation: (activatesGoal: boolean) => void;
  awaitInitialGoalTurn: () => void;
  projectGoalResponse: (
    threadId: string,
    goal: unknown,
    sequenceAtResponse: number,
  ) => ProviderGoalSnapshot | null;
  setContinuationError: (
    error: CodexAppServerResult["continuationError"],
  ) => void;
  setCompatibilityError?: (
    error: CodexAppServerResult["compatibilityError"],
  ) => void;
  deferSessionInstruction?: () => void;
  setPhase: (phase: CodexRunPhase) => void;
  isSettled: () => boolean;
  isCancelRequested: () => boolean;
  finish: (
    status: CodexAppServerResult["status"],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
}
