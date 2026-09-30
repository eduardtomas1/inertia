import type { AgentGoal, AgentGoalStatus } from "../../shared/contracts";
import { objectValue } from "../codex/protocol";

export function exactBoundedString(
  value: unknown,
  maximum: number,
): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.includes("\0")
  ) return undefined;
  return value;
}

export function boundedDisplayString(
  value: unknown,
  maximum: number,
): string | undefined {
  const exact = exactBoundedString(value, maximum);
  const clean = exact?.trim();
  return clean || undefined;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return null;
  return value;
}

function isoFromUnixSeconds(value: unknown): string | null {
  const seconds = boundedInteger(value, 0, 32_503_680_000);
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

export function parseCodexGoal(
  conversationId: string,
  expectedSessionId: string,
  value: unknown,
  synchronizedAt = new Date().toISOString(),
): AgentGoal | null {
  const goal = objectValue(value);
  const providerSessionId = exactBoundedString(goal?.threadId, 512);
  const objective = boundedDisplayString(goal?.objective, 4_000);
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
  const createdAt = isoFromUnixSeconds(goal?.createdAt);
  const updatedAt = isoFromUnixSeconds(goal?.updatedAt);
  const hasTokenBudget = goal?.tokenBudget !== undefined
    && goal.tokenBudget !== null;
  const tokenBudget = hasTokenBudget
    ? boundedInteger(goal?.tokenBudget, 1, 1_000_000_000)
    : null;
  if (
    providerSessionId !== expectedSessionId
    || !objective
    || !status
    || tokensUsed === null
    || timeUsedSeconds === null
    || !createdAt
    || !updatedAt
    || createdAt > updatedAt
    || (hasTokenBudget && tokenBudget === null)
  ) return null;
  return {
    conversationId,
    source: "codex-native",
    providerSessionId,
    objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
    synchronizedAt,
  };
}
