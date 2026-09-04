import type { AgentInputRequest } from "@shared/contracts";

export type AgentInputDraft = Readonly<Record<string, string | readonly string[]>>;

export function agentRequestProviderName(providerId: AgentInputRequest["providerId"] | string): string {
  switch (providerId) {
    case "claude": return "Claude";
    case "cursor": return "Cursor";
    case "gemini": return "Gemini";
    case "kimi": return "Kimi Code";
    case "opencode": return "OpenCode";
    case "codex": return "Codex";
    default: return "The agent";
  }
}

export function inputRequestTitle(providerId: AgentInputRequest["providerId"] | string): string {
  return `${agentRequestProviderName(providerId)} needs your input`;
}

export function buildAgentInputAnswers(
  request: AgentInputRequest,
  answers: AgentInputDraft,
): Record<string, string[]> {
  return Object.fromEntries(request.questions.map(({ id, allowMultiple }) => {
    const draft = answers[id];
    const values = (Array.isArray(draft) ? draft : [draft ?? ""])
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    return [id, allowMultiple ? values : values.slice(0, 1)];
  }));
}
