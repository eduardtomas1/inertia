import type { AgentInputRequest } from "@shared/contracts";

export type AgentInputDraft = Readonly<Record<string, string | readonly string[]>>;

export function inputRequestTitle(providerId: AgentInputRequest["providerId"] | string): string {
  switch (providerId) {
    case "claude": return "Claude needs your input";
    case "cursor": return "Cursor needs your input";
    case "opencode": return "OpenCode needs your input";
    case "codex": return "Codex needs your input";
    default: return "The agent needs your input";
  }
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
