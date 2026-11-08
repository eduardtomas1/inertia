import { z } from "zod";

import { orchestrationIdSchema as id } from "./orchestration-identities";

export const RUN_INTERRUPT_OUTCOMES = ["settled", "force-detached", "expired", "failed", "missing", "identity-mismatch"] as const;
export const RUN_INTERRUPT_ESCALATION_CAUSES = ["grace-expired", "user"] as const;
export const RUN_STEER_OUTCOMES = ["accepted", "refused", "turn-ended", "unconfirmed", "unavailable"] as const;
export const RUN_STEER_STATES = ["dispatching", "settled"] as const;

export type RunInterruptOutcome = (typeof RUN_INTERRUPT_OUTCOMES)[number];
export type RunInterruptEscalationCause = (typeof RUN_INTERRUPT_ESCALATION_CAUSES)[number];
export type RunSteerOutcome = (typeof RUN_STEER_OUTCOMES)[number];

const timestamp = z.iso.datetime();

export const runInterruptSchema = z.strictObject({
  runId: id,
  attemptId: id,
  effectId: id.nullable(),
  requestedAt: timestamp.nullable(),
  expectedTurnId: id.nullable(),
  unresponsiveAt: timestamp.nullable(),
  escalations: z.number().int().nonnegative(),
  outcome: z.enum(RUN_INTERRUPT_OUTCOMES).nullable(),
  settledAt: timestamp.nullable(),
});

export const runSteerSchema = z.strictObject({
  runId: id,
  attemptId: id,
  effectId: id,
  requestedAt: timestamp,
  state: z.enum(RUN_STEER_STATES),
  outcome: z.enum(RUN_STEER_OUTCOMES).nullable(),
  messageId: id.nullable(),
  queuedMessageId: id.nullable(),
  settledAt: timestamp.nullable(),
});

export const runControlEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run-control.interrupt-recorded"), payload: z.strictObject({
    runId: id, attemptId: id, effectId: id, requestedAt: timestamp, expectedTurnId: id.nullable(),
  }) }),
  z.strictObject({ type: z.literal("run-control.interrupt-escalated"), payload: z.strictObject({
    runId: id, attemptId: id, cause: z.enum(RUN_INTERRUPT_ESCALATION_CAUSES), at: timestamp,
  }) }),
  z.strictObject({ type: z.literal("run-control.interrupt-settled"), payload: z.strictObject({
    runId: id, attemptId: id, effectId: id.nullable(), outcome: z.enum(RUN_INTERRUPT_OUTCOMES),
  }) }),
  z.strictObject({ type: z.literal("run-control.steer-requested"), payload: z.strictObject({
    runId: id, attemptId: id, effectId: id, requestedAt: timestamp,
  }) }),
  z.strictObject({ type: z.literal("run-control.steer-settled"), payload: z.strictObject({
    runId: id, attemptId: id, effectId: id, outcome: z.enum(RUN_STEER_OUTCOMES),
    messageId: id.nullable(), queuedMessageId: id.nullable(),
  }) }),
]);

export type RunInterrupt = z.infer<typeof runInterruptSchema>;
export type RunSteer = z.infer<typeof runSteerSchema>;
export type RunControlEvent = z.infer<typeof runControlEventSchema>;
