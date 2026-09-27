import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_MESSAGE_DRAIN_TIMEOUT = Symbol("claude-message-drain-timeout");

export async function nextClaudeMessage(
  iterator: AsyncIterator<SDKMessage>,
  timeoutMs: number | null,
  signal: AbortSignal,
): Promise<IteratorResult<SDKMessage> | typeof CLAUDE_MESSAGE_DRAIN_TIMEOUT> {
  signal.throwIfAborted();
  if (timeoutMs !== null && timeoutMs <= 0) return CLAUDE_MESSAGE_DRAIN_TIMEOUT;
  let timer: NodeJS.Timeout | undefined;
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const pending: Array<Promise<IteratorResult<SDKMessage> | typeof CLAUDE_MESSAGE_DRAIN_TIMEOUT>> = [iterator.next(), cancelled];
    if (timeoutMs !== null) pending.push(new Promise((resolve) => {
      timer = setTimeout(() => resolve(CLAUDE_MESSAGE_DRAIN_TIMEOUT), timeoutMs);
      timer.unref();
    }));
    return await Promise.race(pending);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
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
