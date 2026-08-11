import { describe, expect, it } from "vitest";

import type { AgentTurnUsageSnapshot } from "../../src/shared/contracts";
import {
  previousTurnBoundaryUsage,
  updateActiveTurnProviderSession,
} from "../../src/server/runtime/turns/turn-controller-support";

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
    providerSessionBound: true,
    capturedAt: "2026-08-11T10:00:00.000Z",
  };
}

describe("turn usage boundaries", () => {
  it("uses only the immediately preceding terminal turn's owned completion", () => {
    expect(previousTurnBoundaryUsage(
      {
        association: "authoritative",
        providerSessionAfter: "session-1",
        status: "completed",
        usageAtCompletion: usage(),
      },
      "session-1",
    )).toMatchObject({
      totalProcessedTokens: 100,
      totalProcessedScope: "thread",
      capturedAt: "2026-08-11T10:00:00.000Z",
    });
    expect(previousTurnBoundaryUsage(
      {
        association: "authoritative",
        providerSessionAfter: "session-1",
        status: "completed",
        usageAtCompletion: null,
      },
      "session-1",
    )).toBeNull();
    expect(previousTurnBoundaryUsage(null, "session-1")).toBeNull();
    expect(previousTurnBoundaryUsage(
      {
        association: "authoritative",
        providerSessionAfter: "session-1",
        status: "running",
        usageAtCompletion: usage(),
      },
      "session-1",
    )).toBeNull();
    expect(previousTurnBoundaryUsage(
      {
        association: "inferred",
        providerSessionAfter: "session-1",
        status: "completed",
        usageAtCompletion: usage(),
      },
      "session-1",
    )).toBeNull();
    expect(previousTurnBoundaryUsage(
      {
        association: "authoritative",
        providerSessionAfter: "session-2",
        status: "completed",
        usageAtCompletion: usage(),
      },
      "session-1",
    )).toBeNull();
    expect(previousTurnBoundaryUsage(
      {
        association: "authoritative",
        providerSessionAfter: "session-1",
        status: "completed",
        usageAtCompletion: {
          ...usage(),
          providerSessionBound: false,
        },
      },
      "session-1",
    )).toBeNull();
  });

  it("invalidates a captured boundary when the provider session changes", () => {
    const active = {
      sessionAfter: "session-1",
      lastUsage: usage(),
    };
    updateActiveTurnProviderSession(active, "session-2");
    expect(active).toMatchObject({
      sessionAfter: "session-2",
      lastUsage: { providerSessionBound: false },
    });
    expect(previousTurnBoundaryUsage({
      association: "authoritative",
      providerSessionAfter: "session-2",
      status: "completed",
      usageAtCompletion: active.lastUsage,
    }, "session-2")).toBeNull();

    active.lastUsage = usage();
    updateActiveTurnProviderSession(active, "session-2");
    expect(previousTurnBoundaryUsage({
      association: "authoritative",
      providerSessionAfter: "session-2",
      status: "completed",
      usageAtCompletion: active.lastUsage,
    }, "session-2")).toMatchObject({
      totalProcessedTokens: 100,
      providerSessionBound: true,
    });
  });
});
