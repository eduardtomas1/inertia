import { randomUUID } from "node:crypto";

import { boundedText, objectValue, type JsonObject } from "./protocol";
import type { AgentInputQuestion, AgentInputRequest } from "../provider/interactions";

export function parseCodexInputRequest(method: string, params: JsonObject): AgentInputRequest | undefined {
  if (method !== "item/tool/requestUserInput" || !Array.isArray(params.questions)) return undefined;
  const questions: AgentInputQuestion[] = [];
  for (const value of params.questions.slice(0, 3)) {
    const question = objectValue(value);
    if (!question) continue;
    const id = boundedText(question.id, 120);
    const prompt = boundedText(question.question, 1_000);
    if (!id || !prompt) continue;
    const options: AgentInputQuestion["options"] = [];
    if (Array.isArray(question.options)) {
      for (const rawOption of question.options.slice(0, 3)) {
        const option = objectValue(rawOption);
        const label = boundedText(option?.label, 160);
        if (!label) continue;
        options.push({
          id: boundedText(option?.id, 160) ?? label,
          label,
          description: boundedText(option?.description, 500) ?? "",
        });
      }
    }
    questions.push({
      id,
      header: boundedText(question.header, 120) ?? "Question",
      question: prompt,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      allowMultiple: question.allowMultiple === true,
      options,
    });
  }
  if (questions.length === 0) return undefined;
  const autoResolutionMs = typeof params.autoResolutionMs === "number" && Number.isFinite(params.autoResolutionMs)
    ? Math.max(0, Math.min(Math.trunc(params.autoResolutionMs), 24 * 60 * 60 * 1_000))
    : null;
  return { requestId: randomUUID(), questions, autoResolutionMs };
}

export function codexInputAnswers(
  request: AgentInputRequest,
  answers: Record<string, string[]>,
): Record<string, { answers: string[] }> | undefined {
  const response: Record<string, { answers: string[] }> = {};
  for (const question of request.questions) {
    const values = answers[question.id];
    if (!Array.isArray(values) || values.length === 0) return undefined;
    const optionLabels = new Map(question.options.map((option) => [option.id, option.label]));
    const exact = values
      .filter((value): value is string => typeof value === "string")
      .slice(0, question.allowMultiple ? 5 : 1)
      .map((value) => optionLabels.get(value) ?? value);
    if (exact.length === 0 || exact.some((value) => !value.trim() || value.length > 4_000 || value.includes("\0"))) return undefined;
    response[question.id] = { answers: exact };
  }
  return response;
}
