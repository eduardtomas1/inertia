import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_MESSAGE_DRAIN_TIMEOUT = Symbol("claude-message-drain-timeout");

export async function nextClaudeMessage(
  iterator: AsyncIterator<SDKMessage>,
  timeoutMs: number | null,
): Promise<IteratorResult<SDKMessage> | typeof CLAUDE_MESSAGE_DRAIN_TIMEOUT> {
  if (timeoutMs === null) return await iterator.next();
  if (timeoutMs <= 0) return CLAUDE_MESSAGE_DRAIN_TIMEOUT;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof CLAUDE_MESSAGE_DRAIN_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(CLAUDE_MESSAGE_DRAIN_TIMEOUT), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function claudeFastModeFailure(record: Record<string, unknown>): string {
  const reason = typeof record.fast_mode_disabled_reason === "string" ? record.fast_mode_disabled_reason : undefined;
  const detail = reason === "model_not_allowed"
    ? "The selected Claude model does not allow Fast mode."
    : reason === "sdk_opt_in_required"
      ? "This Claude Agent SDK version did not accept the Fast mode opt-in."
      : reason === "extra_usage_disabled"
        ? "Fast mode requires extra usage to be enabled for this Claude account."
        : reason === "not_first_party"
          ? "Fast mode is unavailable through this Claude backend."
          : reason === "disabled_by_env"
            ? "Fast mode is disabled by the Claude environment."
            : reason === "free"
              ? "Fast mode is unavailable on this Claude account tier."
              : "Claude did not activate Fast mode for this session.";
  return `${detail} Choose Standard, refresh models, or update Claude Code.`;
}
