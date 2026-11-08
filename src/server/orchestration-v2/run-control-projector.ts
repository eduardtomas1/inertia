import { orchestrationAttemptSchema, orchestrationRunSchema } from "../../shared/orchestration-v2";
import {
  runInterruptSchema,
  runSteerSchema,
  type RunControlEvent,
  type RunInterrupt,
} from "../../shared/orchestration-run-control";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

export const RUN_INTERRUPT_PROJECTION = "run-interrupt";
export const RUN_STEER_PROJECTION = "run-steer";

export function isRunControlEvent<T extends { type: string }>(event: T): event is Extract<T, RunControlEvent> {
  return event.type.startsWith("run-control.");
}

function target(read: ProjectionReader, envelope: OrchestrationEvent, runId: string, attemptId: string) {
  const runRow = read("run", runId);
  const attemptRow = read("attempt", attemptId);
  if (!runRow || !attemptRow || runRow.threadId !== envelope.threadId || attemptRow.threadId !== envelope.threadId) {
    throw new OrchestrationConflict("scope-conflict");
  }
  const run = orchestrationRunSchema.parse(runRow.value);
  const attempt = orchestrationAttemptSchema.parse(attemptRow.value);
  if (attempt.runId !== run.id) throw new OrchestrationConflict("scope-conflict");
  return { run, attempt };
}

function requireCurrent(read: ProjectionReader, envelope: OrchestrationEvent, runId: string, attemptId: string): void {
  const { run } = target(read, envelope, runId, attemptId);
  if (run.attemptId !== attemptId || isAgentTurnTerminalStatus(run.status)) throw new OrchestrationConflict("revision-conflict");
}

function interrupt(read: ProjectionReader, attemptId: string): RunInterrupt | null {
  const row = read(RUN_INTERRUPT_PROJECTION, attemptId);
  return row ? runInterruptSchema.parse(row.value) : null;
}

export function projectRunControlEvent(event: RunControlEvent, envelope: OrchestrationEvent, read: ProjectionReader): ProjectionWrite[] {
  switch (event.type) {
    case "run-control.interrupt-recorded": {
      const { runId, attemptId, effectId, requestedAt, expectedTurnId } = event.payload;
      requireCurrent(read, envelope, runId, attemptId);
      if (read(RUN_INTERRUPT_PROJECTION, attemptId)) throw new OrchestrationConflict("revision-conflict");
      return [{ kind: RUN_INTERRUPT_PROJECTION, id: attemptId, value: runInterruptSchema.parse({ runId, attemptId,
        effectId, requestedAt, expectedTurnId, unresponsiveAt: null, escalations: 0, outcome: null, settledAt: null }) }];
    }
    case "run-control.interrupt-escalated": {
      const { runId, attemptId, cause, at } = event.payload;
      target(read, envelope, runId, attemptId);
      const current = interrupt(read, attemptId) ?? { runId, attemptId, effectId: null, requestedAt: null,
        expectedTurnId: null, unresponsiveAt: null, escalations: 0, outcome: null, settledAt: null };
      if (current.runId !== runId || current.outcome !== null) throw new OrchestrationConflict("revision-conflict");
      return [{ kind: RUN_INTERRUPT_PROJECTION, id: attemptId, value: runInterruptSchema.parse({ ...current,
        unresponsiveAt: cause === "grace-expired" ? current.unresponsiveAt ?? at : current.unresponsiveAt,
        escalations: current.escalations + 1 }) }];
    }
    case "run-control.interrupt-settled": {
      const { runId, attemptId, effectId, outcome } = event.payload;
      target(read, envelope, runId, attemptId);
      const current = interrupt(read, attemptId);
      if (!current || current.runId !== runId || current.effectId !== effectId || current.outcome !== null) {
        throw new OrchestrationConflict("revision-conflict");
      }
      return [{ kind: RUN_INTERRUPT_PROJECTION, id: attemptId, value: runInterruptSchema.parse({ ...current,
        outcome, settledAt: envelope.createdAt }) }];
    }
    case "run-control.steer-requested": {
      const { runId, attemptId, effectId, requestedAt } = event.payload;
      requireCurrent(read, envelope, runId, attemptId);
      if (read(RUN_STEER_PROJECTION, effectId)) throw new OrchestrationConflict("revision-conflict");
      return [{ kind: RUN_STEER_PROJECTION, id: effectId, value: runSteerSchema.parse({ runId, attemptId, effectId,
        requestedAt, state: "dispatching", outcome: null, messageId: null, queuedMessageId: null, settledAt: null }) }];
    }
    case "run-control.steer-settled": {
      const { runId, attemptId, effectId, outcome, messageId, queuedMessageId } = event.payload;
      target(read, envelope, runId, attemptId);
      const row = read(RUN_STEER_PROJECTION, effectId);
      const current = row && row.threadId === envelope.threadId ? runSteerSchema.parse(row.value) : null;
      if (!current || current.runId !== runId || current.attemptId !== attemptId || current.state !== "dispatching") {
        throw new OrchestrationConflict("revision-conflict");
      }
      return [{ kind: RUN_STEER_PROJECTION, id: effectId, value: runSteerSchema.parse({ ...current,
        state: "settled", outcome, messageId, queuedMessageId, settledAt: envelope.createdAt }) }];
    }
  }
}
