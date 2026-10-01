import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  sanitizeProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "./activity-detail";
import type { ProviderRunFailure, ProviderRunResult } from "./contracts";
import {
  describePosixCleanupDiagnostic,
  type PosixCleanupDiagnostic,
} from "../posix-cleanup-diagnostics";
import { acpResumeStep, acpSessionUnavailable } from "./session-unavailable";

export function cursorCleanupResult(
  outcome: ProviderRunResult,
  child: ChildProcessWithoutNullStreams,
  workspaceRoot: string,
  subject: "process-tree" | "host-tools",
  cleanupDiagnostic: PosixCleanupDiagnostic | null = null,
): ProviderRunResult {
  const error = subject === "process-tree"
    ? "Cursor ACP process tree could not be confirmed stopped."
    : "Cursor Inertia chat tools could not be cleaned up.";
  const priorFailure = outcome.failure
    ? cursorPriorFailureDetail(outcome.failure, workspaceRoot)
    : undefined;
  const technicalDetail = cleanupDiagnostic
    ? sanitizeProviderActivityDetail(
        [describePosixCleanupDiagnostic(cleanupDiagnostic), priorFailure]
          .filter(Boolean).join("\n"),
        { workspaceRoot, maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS },
      )
    : priorFailure;
  return {
    ...outcome,
    status: "failed",
    exitCode: child.exitCode,
    signal: child.signalCode,
    error,
    failure: {
      reason: "provider-error",
      message: error,
      phase: "cleanup",
      terminalEvent: `${subject}/cleanup`,
      ...(technicalDetail ? { technicalDetail } : {}),
    },
    cleanupConfirmed: false,
  };
}

export function cursorRuntimeFailure(
  message: string,
  child: ChildProcessWithoutNullStreams,
  phase = "runtime",
  terminalEvent = "acp/exception",
  workspaceRoot?: string,
  diagnostic?: string,
): ProviderRunFailure {
  const normalized = message.toLowerCase();
  const reason: ProviderRunFailure["reason"] =
    /oversized|bounded event rate|bounded tool activity/u.test(normalized)
      ? "protocol-overflow"
      : /malformed|unserializable|invalid utf|not valid.*utf-?8|unexpected token|valid json|cursor acp sent an invalid|invalid (?:.* identity|session update)/u.test(normalized)
        ? "malformed-protocol"
        : /timed out|timeout|deadline|stopped responding/u.test(normalized)
          ? "rpc-timeout"
          : child.signalCode
          ? "process-signal"
          : child.exitCode !== null
            ? "process-exit"
            : /closed|connection|eof|broken pipe/u.test(normalized)
              ? "transport-closed"
              : "provider-error";
  const summary = sanitizeProviderFailureSummary(
    message, "Cursor ACP stopped unexpectedly.", { workspaceRoot },
  );
  const technicalDetail = sanitizeProviderActivityDetail([message, diagnostic].filter(Boolean).join("\n"), {
    workspaceRoot, maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  });
  return {
    reason,
    message: summary,
    phase,
    terminalEvent,
    ...(technicalDetail && technicalDetail !== summary ? { technicalDetail } : {}),
    ...(reason === "provider-error" && acpSessionUnavailable(terminalEvent, message)
      ? { sessionUnavailable: true as const }
      : {}),
    ...(reason === "provider-error" && acpResumeStep(terminalEvent)
      ? { resumeRejected: true as const }
      : {}),
  };
}

export function cursorPriorFailureDetail(
  failure: ProviderRunFailure,
  workspaceRoot: string,
): string | null {
  const prior = [
    `Prior failure reason: ${failure.reason}`,
    ...(failure.phase ? [`Prior failure phase: ${failure.phase}`] : []),
    ...(failure.terminalEvent
      ? [`Prior terminal event: ${failure.terminalEvent}`]
      : []),
    `Prior failure: ${failure.message}`,
    ...(failure.technicalDetail
      ? [`Prior technical detail:\n${failure.technicalDetail}`]
      : []),
  ].join("\n");
  return sanitizeProviderActivityDetail(prior, {
    workspaceRoot,
    maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  });
}
