import { describe, expect, it } from "vitest";

import type { AgentTurnUsageSnapshot } from "../../src/shared/contracts";
import { previousTurnBoundaryUsage } from "../../src/server/runtime/turns/turn-controller-support";

function usage(): AgentTurnUsageSnapshot {
  return {
    usedTokens: 60,
    totalProcessedTokens: 100,
    totalProcessedScope: "thread",
    maxTokens: 1_000,
    inputTokens: 50,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 2,
    compactsAutomatically: false,
    capturedAt: "2026-08-11T10:00:00.000Z",
  };
}

describe("turn usage boundaries", () => {
  it("uses only the immediately preceding terminal turn's owned completion", () => {
    expect(previousTurnBoundaryUsage(
      {
        association: "authoritative",
        status: "completed",
        usageAtCompletion: usage(),
      },
    )).toMatchObject({
      totalProcessedTokens: 100,
      totalProcessedScope: "thread",
      capturedAt: "2026-08-11T10:00:00.000Z",
    });
    expect(previousTurnBoundaryUsage(
      {
        association: "authoritative",
        status: "completed",
        usageAtCompletion: null,
      },
    )).toBeNull();
    expect(previousTurnBoundaryUsage(null)).toBeNull();
    expect(previousTurnBoundaryUsage(
      {
        association: "authoritative",
        status: "running",
        usageAtCompletion: usage(),
      },
    )).toBeNull();
    expect(previousTurnBoundaryUsage(
      {
        association: "inferred",
        status: "completed",
        usageAtCompletion: usage(),
      },
    )).toBeNull();
  });
});
