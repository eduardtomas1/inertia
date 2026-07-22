import type { AgentInputRequest } from "@shared/contracts";

export function buildAgentInputAnswers(
  request: AgentInputRequest,
  answers: Readonly<Record<string, string>>,
): Record<string, string[]> {
  return Object.fromEntries(request.questions.map(({ id }) => [id, [answers[id] ?? ""]]));
}
