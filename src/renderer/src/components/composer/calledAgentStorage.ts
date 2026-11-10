const CALLED_AGENT_KEY_PREFIX = "inertia:called-agent:";

export function readCalledAgentId(conversationId: string): string | null {
  try {
    return window.localStorage.getItem(`${CALLED_AGENT_KEY_PREFIX}${conversationId}`);
  } catch {
    return null;
  }
}

export function persistCalledAgentId(conversationId: string, agentId: string | null): void {
  try {
    const key = `${CALLED_AGENT_KEY_PREFIX}${conversationId}`;
    if (agentId) window.localStorage.setItem(key, agentId);
    else window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

export function forgetCalledAgent(conversationId: string): void {
  persistCalledAgentId(conversationId, null);
}
