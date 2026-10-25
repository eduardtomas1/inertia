import type { TurnFailureKind } from "../../shared/turn-lifecycle";
import type { ProviderRunFailure } from "../provider/contracts";
import type { CodexRunPhase } from "./app-server-config";
import type { CappedTextBuffer, JsonObject } from "./protocol";
import type { CodexAppServerOptions, CodexAppServerResult } from "./types";

export interface CodexAppServerEventHost {
  options: CodexAppServerOptions;
  resultText: CappedTextBuffer;
  isSettled: () => boolean;
  phase: () => CodexRunPhase;
  setPhase: (phase: CodexRunPhase) => void;
  providerThreadId: () => string | undefined;
  activeTurnId: () => string | undefined;
  setActiveTurnId: (turnId: string | undefined) => void;
  requestedTurnId?: () => string | null | undefined;
  cancelRequested: () => boolean;
  lastError: () => string | undefined;
  setLastError: (message: string) => void;
  setLastProtocolMethod: (method: string) => void;
  setLastActivityId: (activityId: string) => void;
  setTerminalEvent: (event: string) => void;
  writeMessage: (message: JsonObject) => boolean;
  cancel: (reason?: "malformed-protocol") => void;
  finish: (
    status: CodexAppServerResult["status"],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  rememberFailure: (
    reason: ProviderRunFailure["reason"],
    message: string,
    technicalDetail?: string,
    usageLimited?: boolean,
    failureKind?: TurnFailureKind,
  ) => void;
}
