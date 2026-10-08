import type { AgentInputRequest } from "@shared/contracts";

export type AgentInputDraft = Readonly<Record<string, string | readonly string[]>>;

export function agentRequestProviderName(providerId: AgentInputRequest["providerId"] | string): string {
  switch (providerId) {
    case "claude": return "Claude";
    case "cursor": return "Cursor";
    case "antigravity": return "Antigravity";
    case "kimi": return "Kimi Code";
    case "opencode": return "OpenCode";
    case "codex": return "Codex";
    default: return "The agent";
  }
}

export function inputRequestTitle(
  providerId: AgentInputRequest["providerId"] | string,
  questionCount: number,
): string {
  const asks = questionCount === 1 ? "has a question" : `has ${questionCount} questions`;
  return `${agentRequestProviderName(providerId)} ${asks}`;
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
