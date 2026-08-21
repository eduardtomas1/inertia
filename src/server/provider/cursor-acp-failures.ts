import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  sanitizeProviderActivityDetail,
} from "./activity-detail";
import type { ProviderRunFailure } from "./contracts";

export function cursorRuntimeFailure(
  message: string,
  child: ChildProcessWithoutNullStreams,
  phase = "runtime",
  terminalEvent = "acp/exception",
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
  return {
    reason,
    message,
    phase,
    terminalEvent,
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
