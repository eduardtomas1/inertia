import { vi } from "vitest";

import { OrchestrationCommandAuthority } from "../../src/server/orchestration-v2/command-authority";
import { OrchestrationCommandLanes } from "../../src/server/orchestration-v2/command-lanes";
import type { OrchestrationEventStore } from "../../src/server/orchestration-v2/event-store";
import type { CommandReceipt } from "../../src/server/orchestration-v2/types";

export function mockCommandOrchestration() {
  const events = {
    receipt: vi.fn((): CommandReceipt | null => null),
    reject: vi.fn(),
    commit: vi.fn(() => ({ replayed: false, receipt: null, events: [] })),
    revision: vi.fn(() => 0),
  };
  const lanes = new OrchestrationCommandLanes();
  return {
    events,
    lanes,
    acceptedRequest: vi.fn(() => null),
    authority: new OrchestrationCommandAuthority(events as unknown as OrchestrationEventStore, lanes),
    runControl: {
      target: vi.fn(() => null),
      interruptRequested: vi.fn(() => false),
      requestSteer: vi.fn(() => ({ kind: "untracked" as const })),
      settleSteer: vi.fn(),
      settleInterrupt: vi.fn(() => false),
      unsettledSteers: vi.fn(() => []),
      unsettledSteersBefore: vi.fn(() => []),
      awaitSettled: vi.fn(async () => true),
      steer: vi.fn(() => null),
    },
  };
}

export function acceptedReceipt(result: CommandReceipt["result"]): CommandReceipt {
  return {
    actorId: "human", commandId: "replayed", projectId: "project", threadId: "thread", fingerprint: "fingerprint",
    firstSequence: 1, lastSequence: 1, result, createdAt: "2030-01-01T00:00:00.000Z",
    status: "accepted", error: null, commandType: "message.send",
  };
}
