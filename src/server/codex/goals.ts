import type { AgentGoalStatus } from "../../shared/contracts";
import type { ProviderGoalSnapshot } from "../provider/contracts";
import { objectValue, type JsonObject } from "./protocol";

export interface CodexGoalUpdatedNotification {
  threadId: string;
  goal: ProviderGoalSnapshot;
}

function exactBoundedText(
  value: unknown,
  maximum: number,
): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.includes("\0")
  ) return null;
  return value;
}

function nonEmptyObjective(value: unknown): string | null {
  const objective = exactBoundedText(value, 4_000);
  return objective?.trim() ? objective : null;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : null;
}

function goalStatus(value: unknown): AgentGoalStatus | null {
  return value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "usageLimited"
    || value === "budgetLimited"
    || value === "complete"
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  const seconds = boundedInteger(value, 0, 32_503_680_000);
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseCodexGoalUpdatedNotification(
  params: JsonObject,
): CodexGoalUpdatedNotification | null {
  const threadId = exactBoundedText(params.threadId, 512);
  const goal = objectValue(params.goal);
  const goalThreadId = exactBoundedText(goal?.threadId, 512);
  const objective = nonEmptyObjective(goal?.objective);
  const status = goalStatus(goal?.status);
  const tokensUsed = boundedInteger(
    goal?.tokensUsed,
    0,
    1_000_000_000_000,
  );
  const timeUsedSeconds = boundedInteger(
    goal?.timeUsedSeconds,
    0,
    315_360_000,
  );
  const createdAt = timestamp(goal?.createdAt);
  const updatedAt = timestamp(goal?.updatedAt);
  const hasTokenBudget = goal?.tokenBudget !== undefined
    && goal.tokenBudget !== null;
  const tokenBudget = !hasTokenBudget
    ? null
    : boundedInteger(goal?.tokenBudget, 1, 1_000_000_000);
  if (
    !threadId
    || goalThreadId !== threadId
    || !objective
    || !status
    || tokensUsed === null
    || timeUsedSeconds === null
    || !createdAt
    || !updatedAt
    || (hasTokenBudget && tokenBudget === null)
  ) return null;
  return {
    threadId,
    goal: {
      objective,
      status,
      tokenBudget,
      tokensUsed,
      timeUsedSeconds,
      createdAt,
      updatedAt,
    },
  };
}

export function parseCodexGoalClearedNotification(
  params: JsonObject,
): string | null {
  return exactBoundedText(params.threadId, 512);
}
