import type { RuntimeStore } from "../../database";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  resolveTurnRequest,
  type PrepareTurnRequestDependencies,
  type PreparedTurnRequest,
} from "./turn-request-preparation";
import type {
  QueuedTurn,
  QueueTurnRequest,
} from "./turn-controller-types";

interface TurnPairedQueueOptions extends PrepareTurnRequestDependencies {
  store: RuntimeStore;
  isClosing(): boolean;
  hasAdmission(conversationId: string): boolean;
  blocksForGoalMutation(conversationId: string): boolean;
  isActive(conversationId: string): boolean;
  adopt(prepared: PreparedTurnRequest): QueuedTurn;
  failAdoption(
    queued: QueuedTurn,
    checkpointId: string | null,
    error: unknown,
  ): void;
}

export function queuePairedTurns(
  options: TurnPairedQueueOptions,
  launchId: string,
  requests: readonly [QueueTurnRequest, QueueTurnRequest],
): [QueuedTurn, QueuedTurn] {
  if (options.isClosing()) {
    throw new Error("The local runtime is shutting down.");
  }
  for (const request of requests) {
    if (options.hasAdmission(request.conversationId)) {
      throw new RuntimeRequestError(
        "Another message is being prepared for this conversation.",
      );
    }
    options.store.assertDuoComparisonTurnAllowed(request.conversationId);
    if (options.blocksForGoalMutation(request.conversationId)) {
      throw new Error(
        "A Codex goal update is in progress for this conversation.",
      );
    }
    if (options.isActive(request.conversationId)) {
      throw new Error("A Duo conversation already has an active turn.");
    }
  }
  if (requests[0].conversationId === requests[1].conversationId) {
    throw new Error("A Duo requires two distinct conversations.");
  }
  const resolved = requests.map((request) =>
    resolveTurnRequest(options, request)) as [
      ReturnType<typeof resolveTurnRequest>,
      ReturnType<typeof resolveTurnRequest>,
    ];
  const durable = options.store.beginPairedAgentTurns(
    launchId,
    [resolved[0].input, resolved[1].input],
    options.now(),
  );
  try {
    const prepared: [PreparedTurnRequest, PreparedTurnRequest] = [
      resolved[0].adopt(durable[0]),
      resolved[1].adopt(durable[1]),
    ];
    return [options.adopt(prepared[0]), options.adopt(prepared[1])];
  } catch (error) {
    options.failAdoption(
      durable[0],
      requests[0].checkpointId ?? null,
      error,
    );
    options.failAdoption(
      durable[1],
      requests[1].checkpointId ?? null,
      error,
    );
    throw error;
  }
}
