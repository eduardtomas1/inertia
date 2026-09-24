const MAX_STOP_REASON_CHARS = 64;

/**
 * Turns an ACP prompt stop reason other than end_turn into a sentence the user
 * can act on. Unknown reasons keep the raw, bounded token so a new SDK value
 * is still visible.
 */
export function acpStopReasonMessage(agentLabel: string, stopReason: string): string {
  switch (stopReason) {
    case "refusal":
      return `${agentLabel} declined this request.`;
    case "max_tokens":
      return `${agentLabel} hit its output token limit. Ask it to continue.`;
    case "max_turn_requests":
      return `${agentLabel} hit its request limit for this turn. Ask it to continue.`;
    default:
      return `${agentLabel} stopped with reason: ${stopReason.slice(0, MAX_STOP_REASON_CHARS)}.`;
  }
}
