import {
  orchestrationAttemptSchema,
  orchestrationRunSchema,
  orchestrationThreadSchema,
  type OrchestrationDomainEvent,
} from "../../shared/orchestration-v2";
import {
  runInterruptSchema,
  runSteerSchema,
  type RunInterrupt,
  type RunInterruptOutcome,
  type RunSteer,
  type RunSteerOutcome,
} from "../../shared/orchestration-run-control";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { CommandTicket } from "./command-authority";
import type { OrchestrationEffectOutbox } from "./effect-outbox";
import { ORCHESTRATION_EFFECT_KINDS } from "./effect-runtime";
import type { OrchestrationEventStore } from "./event-store";
import { commandFingerprint } from "./json";
import { RUN_INTERRUPT_PROJECTION, RUN_STEER_PROJECTION } from "./run-control-projector";
import type { OrchestrationEffect } from "./types";

export interface RunControlTarget {
  runId: string;
  attemptId: string;
  turnId: string;
  threadId: string;
  projectId: string;
  terminal: boolean;
  interruptRequested: boolean;
}

export type SteerRequest =
  | { kind: "untracked" }
  | { kind: "closed" }
  | { kind: "requested"; effectId: string };

interface Waiter {
  settled: Promise<void>;
  resolve(): void;
}

export class RunControlRepository {
  readonly #claims = new Map<string, OrchestrationEffect>();
  readonly #waiters = new Map<string, Waiter>();

  constructor(
    private readonly events: OrchestrationEventStore,
    private readonly effects: OrchestrationEffectOutbox,
    private readonly startIntent: (runId: string) => OrchestrationEffect | null,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  target(runId: string): RunControlTarget | null {
    const runRow = this.events.projection("run", runId);
    if (!runRow) return null;
    const run = orchestrationRunSchema.parse(runRow.value);
    const attemptRow = this.events.projection("attempt", run.attemptId);
    if (!attemptRow) return null;
    const attempt = orchestrationAttemptSchema.parse(attemptRow.value);
    return { runId: run.id, attemptId: attempt.id, turnId: run.turnId, threadId: run.threadId,
      projectId: run.projectId, terminal: isAgentTurnTerminalStatus(run.status),
      interruptRequested: attempt.interruptRequestedAt !== null };
  }

  activeTarget(threadId: string): RunControlTarget | null {
    const row = this.events.projection("thread", threadId);
    const activeRunId = row ? orchestrationThreadSchema.parse(row.value).activeRunId : null;
    return activeRunId ? this.target(activeRunId) : null;
  }

  interruptRequested(threadId: string): boolean {
    return this.activeTarget(threadId)?.interruptRequested === true;
  }

  attemptInterrupt(attemptId: string): RunInterrupt | null {
    const row = this.events.projection(RUN_INTERRUPT_PROJECTION, attemptId);
    return row ? runInterruptSchema.parse(row.value) : null;
  }

  steer(effectId: string): RunSteer | null {
    const row = this.events.projection(RUN_STEER_PROJECTION, effectId);
    return row ? runSteerSchema.parse(row.value) : null;
  }

  effect(effectId: string): OrchestrationEffect | null {
    return this.effects.get(effectId);
  }

  recordInterrupt(ticket: CommandTicket, target: RunControlTarget, expectedTurnId: string | null): string {
    const effectId = `interrupt:${commandFingerprint({ actorId: ticket.identity.actorId,
      commandId: ticket.identity.commandId, attemptId: target.attemptId })}`;
    const events: OrchestrationDomainEvent[] = [
      { type: "attempt.interrupt-requested", payload: { runId: target.runId, attemptId: target.attemptId } },
      { type: "run-control.interrupt-recorded", payload: { runId: target.runId, attemptId: target.attemptId,
        effectId, requestedAt: this.clock(), expectedTurnId } },
    ];
    const start = this.startIntent(target.runId);
    ticket.commit({ events, effects: [this.controlEffect(effectId, 1, "provider.interrupt", target)],
      result: { stop: "interrupt", runId: target.runId, attemptId: target.attemptId, effectId } }, () => {
      if (start?.state === "pending") this.effects.retirePending(start.id, "stopped");
    });
    this.claim(effectId);
    return effectId;
  }

  escalateByUser(ticket: CommandTicket, target: RunControlTarget): void {
    ticket.commit({ events: [this.escalation(target, "user")],
      result: { stop: "escalated", runId: target.runId, attemptId: target.attemptId } });
  }

  escalateAfterGrace(runId: string): boolean {
    const target = this.target(runId);
    if (!target) return false;
    const current = this.attemptInterrupt(target.attemptId);
    if (current && (current.escalations > 0 || current.outcome !== null)) return false;
    const event = this.escalation(target, "grace-expired");
    this.events.commit({ actorId: "runtime", commandId: `interrupt-escalated:${target.attemptId}:grace-expired`,
      projectId: target.projectId, threadId: target.threadId, command: event,
      expectedRevision: this.events.revision(target.threadId), events: [event], result: null });
    return true;
  }

  settleInterrupt(runId: string, outcome: RunInterruptOutcome): boolean {
    const target = this.target(runId);
    const current = target ? this.attemptInterrupt(target.attemptId) : null;
    if (!target || !current || current.outcome !== null) return false;
    if (current.effectId) {
      this.settleClaim(current.effectId, outcome === "settled" ? null : `stop-${outcome}`);
    }
    const event: OrchestrationDomainEvent = { type: "run-control.interrupt-settled",
      payload: { runId: target.runId, attemptId: target.attemptId, effectId: current.effectId, outcome } };
    this.events.commit({ actorId: "runtime",
      commandId: `interrupt-settled:${current.effectId ?? commandFingerprint(target.attemptId)}`,
      projectId: target.projectId, threadId: target.threadId, command: event,
      expectedRevision: this.events.revision(target.threadId), events: [event], result: null });
    return true;
  }

  requestSteer(ticket: CommandTicket, runId: string, turnId: string): SteerRequest {
    const target = this.target(runId);
    if (!target) return { kind: "untracked" };
    if (target.terminal || target.turnId !== turnId || target.interruptRequested) return { kind: "closed" };
    const effectId = `steer:${commandFingerprint({ actorId: ticket.identity.actorId,
      commandId: ticket.identity.commandId, runId })}`;
    const event: OrchestrationDomainEvent = { type: "run-control.steer-requested",
      payload: { runId, attemptId: target.attemptId, effectId, requestedAt: this.clock() } };
    ticket.commit({ events: [event], effects: [this.controlEffect(effectId, 0, "provider.steer", target)],
      result: { disposition: "follow-up", effectId } });
    this.claim(effectId);
    return { kind: "requested", effectId };
  }

  settleSteer(effectId: string, outcome: RunSteerOutcome,
    refs: { messageId?: string | null; queuedMessageId?: string | null } = {}): void {
    const steer = this.steer(effectId);
    this.settleClaim(effectId, outcome === "accepted" ? null : `steer-${outcome}`);
    if (!steer || steer.state !== "dispatching") return;
    const target = this.target(steer.runId);
    if (!target) return;
    const event: OrchestrationDomainEvent = { type: "run-control.steer-settled", payload: { runId: steer.runId,
      attemptId: steer.attemptId, effectId, outcome, messageId: refs.messageId ?? null,
      queuedMessageId: refs.queuedMessageId ?? null } };
    this.events.commit({ actorId: "runtime", commandId: `steer-settled:${effectId}`,
      projectId: target.projectId, threadId: target.threadId, command: event,
      expectedRevision: this.events.revision(target.threadId), events: [event], result: null });
  }

  unsettledSteersBefore(effectId: string): string[] {
    const effect = this.effects.get(effectId);
    return effect ? this.effects.unsettledBefore(effect.threadId, effect.sequence, ["provider.steer"]) : [];
  }

  unsettledSteers(threadId: string): string[] {
    return this.effects.unsettledBefore(threadId, Number.MAX_SAFE_INTEGER, ["provider.steer"]);
  }

  async awaitSettled(effectIds: readonly string[], deadlineAt: number): Promise<boolean> {
    const waits = effectIds.flatMap((id) => {
      const waiter = this.#waiters.get(id);
      return waiter ? [waiter.settled] : [];
    });
    if (waits.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadlineAt - Date.now()));
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.all(waits).then(() => true), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private escalation(target: RunControlTarget, cause: "grace-expired" | "user"): OrchestrationDomainEvent {
    return { type: "run-control.interrupt-escalated",
      payload: { runId: target.runId, attemptId: target.attemptId, cause, at: this.clock() } };
  }

  private controlEffect(id: string, eventIndex: number, kind: "provider.interrupt" | "provider.steer", target: RunControlTarget) {
    return { id, eventIndex, kind, replayPolicy: ORCHESTRATION_EFFECT_KINDS[kind].replayPolicy,
      payload: { runId: target.runId, attemptId: target.attemptId, turnId: target.turnId } };
  }

  private claim(effectId: string): void {
    const claim = this.effects.claimControl(effectId);
    if (!claim) return;
    this.#claims.set(effectId, claim);
    let resolve!: () => void;
    const settled = new Promise<void>((onResolve) => { resolve = onResolve; });
    this.#waiters.set(effectId, { settled, resolve });
  }

  private settleClaim(effectId: string, failureCode: string | null): void {
    const claim = this.#claims.get(effectId);
    this.#claims.delete(effectId);
    const waiter = this.#waiters.get(effectId);
    this.#waiters.delete(effectId);
    try {
      if (claim) this.effects.settle(claim, failureCode === null ? { kind: "succeeded" } : { kind: "failed", code: failureCode });
      else this.effects.retirePending(effectId, failureCode ?? "control-settled");
    } finally {
      waiter?.resolve();
    }
  }
}
