import { randomUUID } from "node:crypto";

import { objectValue, type JsonObject } from "./protocol";
import type { AgentInputQuestion, AgentInputRequest } from "../provider/interactions";

const MAX_INPUT_QUESTIONS = 3;
const MAX_INPUT_OPTIONS = 3;
const MAX_QUESTION_ID_CHARS = 120;
const MAX_QUESTION_HEADER_CHARS = 120;
const MAX_QUESTION_TEXT_CHARS = 1_000;
const MAX_OPTION_ID_CHARS = 160;
const MAX_OPTION_LABEL_CHARS = 160;
const MAX_OPTION_DESCRIPTION_CHARS = 500;
const MAX_AUTO_RESOLUTION_MS = 24 * 60 * 60 * 1_000;
const CODEX_INPUT_REQUEST_METHOD = "item/tool/requestUserInput";

export interface ParsedCodexInputRequest {
  request: AgentInputRequest;
  providerThreadId: string;
  providerTurnId: string;
  providerItemId: string;
}

export function isCodexInputRequestMethod(method: string): boolean {
  return method === CODEX_INPUT_REQUEST_METHOD;
}

export function parseCodexInputRequest(
  method: string,
  params: JsonObject,
): AgentInputRequest | undefined {
  if (!isCodexInputRequestMethod(method) || !Array.isArray(params.questions)) return undefined;
  if (
    params.questions.length === 0
    || params.questions.length > MAX_INPUT_QUESTIONS
  ) return undefined;
  const questions: AgentInputQuestion[] = [];
  const questionIds = new Set<string>();
  for (const value of params.questions) {
    const question = objectValue(value);
    if (!question) return undefined;
    const id = strictText(question.id, MAX_QUESTION_ID_CHARS);
    const prompt = strictText(question.question, MAX_QUESTION_TEXT_CHARS);
    if (!id || !prompt || questionIds.has(id)) return undefined;
    questionIds.add(id);
    const header = question.header === undefined
      ? "Question"
      : strictText(question.header, MAX_QUESTION_HEADER_CHARS);
    if (!header) return undefined;
    if (
      !optionalBoolean(question.isOther)
      || !optionalBoolean(question.isSecret)
      || !optionalBoolean(question.allowMultiple)
    ) return undefined;
    const options: AgentInputQuestion["options"] = [];
    const optionIds = new Set<string>();
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) return undefined;
      if (question.options.length > MAX_INPUT_OPTIONS) return undefined;
      for (const rawOption of question.options) {
        const option = objectValue(rawOption);
        if (!option) return undefined;
        const label = strictText(option.label, MAX_OPTION_LABEL_CHARS);
        if (!label) return undefined;
        const optionId = option.id === undefined
          ? label
          : strictText(option.id, MAX_OPTION_ID_CHARS);
        const description = option.description === undefined
          ? ""
          : strictText(option.description, MAX_OPTION_DESCRIPTION_CHARS, true);
        if (!optionId || description === undefined || optionIds.has(optionId)) {
          return undefined;
        }
        optionIds.add(optionId);
        options.push({
          id: optionId,
          label,
          description,
        });
      }
    }
    questions.push({
      id,
      header,
      question: prompt,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      allowMultiple: question.allowMultiple === true,
      options,
    });
  }
  const rawAutoResolutionMs = params.autoResolutionMs;
  if (
    rawAutoResolutionMs !== undefined
    && rawAutoResolutionMs !== null
    && (
      !Number.isSafeInteger(rawAutoResolutionMs)
      || (rawAutoResolutionMs as number) < 0
      || (rawAutoResolutionMs as number) > MAX_AUTO_RESOLUTION_MS
    )
  ) return undefined;
  const autoResolutionMs = typeof rawAutoResolutionMs === "number"
    ? rawAutoResolutionMs
    : null;
  return { requestId: randomUUID(), questions, autoResolutionMs };
}

export function parseCodexOwnedInputRequest(
  method: string,
  params: JsonObject,
): ParsedCodexInputRequest | undefined {
  const providerThreadId = strictIdentifier(params.threadId);
  const providerTurnId = strictIdentifier(params.turnId);
  const providerItemId = strictIdentifier(params.itemId);
  if (!providerThreadId || !providerTurnId || !providerItemId) return undefined;
  const request = parseCodexInputRequest(method, params);
  return request
    ? { request, providerThreadId, providerTurnId, providerItemId }
    : undefined;
}

function strictIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  const identifier = value.trim();
  return identifier
      && identifier === value
      && identifier.length <= 1_000
    ? identifier
    : undefined;
}

function strictText(
  value: unknown,
  maxChars: number,
  allowEmpty = false,
): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > maxChars) return undefined;
  return text;
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
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
