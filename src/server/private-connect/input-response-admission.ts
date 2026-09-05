import type { AgentInputRequest } from "../../shared/contracts";
import { pendingInteractionForConversation } from "../runtime/pending-interaction-registry";

export function privateConnectInputResponseAdmissible(
  pendingInputs: ReadonlyMap<string, AgentInputRequest>,
  conversationId: string,
  requestId: string,
  answers: Record<string, string[]>,
): boolean {
  const pending = pendingInteractionForConversation(
    pendingInputs,
    conversationId,
    requestId,
  );
  if (
    !pending
    || pending.conversationContextRequest
    || pending.questions.some((question) => question.isSecret)
  ) return false;
  const expected = new Map(
    pending.questions.map((question) => [question.id, question]),
  );
  for (const [questionId, values] of Object.entries(answers)) {
    const question = expected.get(questionId);
    if (
      !question
      || values.length === 0
      || (!question.allowMultiple && values.length !== 1)
    ) return false;
    const optionIds = new Set(question.options.map((option) => option.id));
    if (
      question.options.length > 0
      && values.some((value) => !optionIds.has(value) && !question.isOther)
    ) return false;
  }
  return [...expected.keys()].every((questionId) => answers[questionId]?.length);
}

export function createPrivateConnectInputResponder(
  pendingInputs: ReadonlyMap<string, AgentInputRequest>,
  turns: {
    respondToInput(
      conversationId: string,
      requestId: string,
      answers: Record<string, string[]>,
    ): boolean;
  },
): (
  conversationId: string,
  requestId: string,
  answers: Record<string, string[]>,
) => boolean {
  return (conversationId, requestId, answers) => (
    privateConnectInputResponseAdmissible(
      pendingInputs,
      conversationId,
      requestId,
      answers,
    ) && turns.respondToInput(conversationId, requestId, answers)
  );
}
