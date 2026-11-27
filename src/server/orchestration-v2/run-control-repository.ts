import type Database from "better-sqlite3";

import {
  orchestrationAttemptSchema,
  orchestrationRunSchema,
  orchestrationThreadSchema,
  type OrchestrationDomainEvent,
} from "../../shared/orchestration-v2";
import {
  MAX_RUN_INTERRUPT_REASON_CHARS,
  runInterruptSchema,
  runSteerSchema,
  type RunInterrupt,
  type RunInterruptCause,
  type RunInterruptEscalationCause,
  type RunInterruptOutcome,
  type RunSteer,
  type RunSteerOutcome,
} from "../../shared/orchestration-run-control";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { CommandTicket } from "./command-authority";
import type { OrchestrationEffectOutbox } from "./effect-outbox";
import { ORCHESTRATION_EFFECT_KINDS, type OrchestrationEffectRuntime } from "./effect-runtime";
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

export interface SteerSettledNotification {
  effectId: string;
  runId: string;
  attemptId: string;
  outcome: RunSteerOutcome;
}

export class RunControlRepository {
  private effectRuntime: OrchestrationEffectRuntime | null = null;
  private readonly steerSettledListeners = new Set<(event: SteerSettledNotification) => void>();

  constructor(
    private readonly events: OrchestrationEventStore,
    private readonly effects: OrchestrationEffectOutbox,
    private readonly startIntent: (runId: string) => OrchestrationEffect | null,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly database: Database.Database = effects.connection,
  ) {}

  attachEffectRuntime(runtime: OrchestrationEffectRuntime | null): void {
    this.effectRuntime = runtime;
  }

  onSteerSettled(listener: (event: SteerSettledNotification) => void): () => void {
    this.steerSettledListeners.add(listener);
    return () => {
      this.steerSettledListeners.delete(listener);
    };
  }

  dispatchesViaEffectRuntime(kind: "provider.interrupt" | "provider.steer"): boolean {
    return this.effectRuntime?.executes(kind) === true;
  }

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

  recordInterrupt(
    ticket: CommandTicket,
    target: RunControlTarget,
    expectedTurnId: string | null,
    cause: RunInterruptCause,
    extra?: { reason?: string | null; events?: readonly OrchestrationDomainEvent[]; afterCommit?: () => void },
  ): string {
    const effectId = `interrupt:${commandFingerprint({ actorId: ticket.identity.actorId,
      commandId: ticket.identity.commandId, attemptId: target.attemptId })}`;
    const normalizedReason = normalizeInterruptReason(extra?.reason);
    const events: OrchestrationDomainEvent[] = [
      { type: "attempt.interrupt-requested", payload: { runId: target.runId, attemptId: target.attemptId } },
      { type: "run-control.interrupt-recorded", payload: {
        runId: target.runId,
        attemptId: target.attemptId,
        effectId,
        requestedAt: this.clock(),
        expectedTurnId,
        cause,
        ...(normalizedReason !== undefined ? { reason: normalizedReason } : {}),
      } },
      ...(extra?.events ?? []),
    ];
    const start = this.startIntent(target.runId);
    ticket.commit({ events, effects: [this.controlEffect(effectId, 1, "provider.interrupt", target)],
      result: { stop: "interrupt", runId: target.runId, attemptId: target.attemptId, effectId } }, () => {
      if (start?.state === "pending") this.effects.retirePending(start.id, "stopped");
      extra?.afterCommit?.();
    });
    if (!this.dispatchesViaEffectRuntime("provider.interrupt")) {
      this.effects.claimControl(effectId);
    }
    return effectId;
  }

  escalateByRequester(
    ticket: CommandTicket,
    target: RunControlTarget,
    cause: RunInterruptCause,
    extra?: { events?: readonly OrchestrationDomainEvent[]; afterCommit?: () => void },
  ): void {
    ticket.commit({
      events: [this.escalation(target, cause), ...(extra?.events ?? [])],
      result: { stop: "escalated", runId: target.runId, attemptId: target.attemptId },
    }, extra?.afterCommit);
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
    const failureCode = outcome === "settled" ? null : `stop-${outcome}`;
    const event: OrchestrationDomainEvent = { type: "run-control.interrupt-settled",
      payload: { runId: target.runId, attemptId: target.attemptId, effectId: current.effectId, outcome } };
    this.events.commit({ actorId: "runtime",
      commandId: `interrupt-settled:${current.effectId ?? commandFingerprint(target.attemptId)}`,
      projectId: target.projectId, threadId: target.threadId, command: event,
      expectedRevision: this.events.revision(target.threadId), events: [event], result: null }, () => {
      if (current.effectId) this.settleEffectRow(current.effectId, failureCode);
    });
    return true;
  }

  requestSteer(
    ticket: CommandTicket,
    runId: string,
    turnId: string,
    options?: { queuedMessageId?: string },
  ): SteerRequest {
    const target = this.target(runId);
    if (!target) return { kind: "untracked" };
    if (target.terminal || target.turnId !== turnId || target.interruptRequested) return { kind: "closed" };
    const effectId = `steer:${commandFingerprint({ actorId: ticket.identity.actorId,
      commandId: ticket.identity.commandId, runId })}`;
    const event: OrchestrationDomainEvent = { type: "run-control.steer-requested",
      payload: { runId, attemptId: target.attemptId, effectId, requestedAt: this.clock() } };
    ticket.commit({
      events: [event],
      effects: [this.controlEffect(effectId, 0, "provider.steer", target, options?.queuedMessageId)],
      result: { disposition: "follow-up", effectId },
    });
    if (!this.dispatchesViaEffectRuntime("provider.steer")) {
      this.effects.claimControl(effectId);
    }
    return { kind: "requested", effectId };
  }

  settleSteer(effectId: string, outcome: RunSteerOutcome,
    refs: { messageId?: string | null; queuedMessageId?: string | null } = {}): void {
    const steer = this.steer(effectId);
    const failureCode = outcome === "accepted" ? null : `steer-${outcome}`;
    if (!steer || steer.state !== "dispatching") {
      this.settleEffectRow(effectId, failureCode);
      return;
    }
    const target = this.target(steer.runId);
    if (!target) {
      this.settleEffectRow(effectId, failureCode);
      return;
    }
    const event: OrchestrationDomainEvent = { type: "run-control.steer-settled", payload: { runId: steer.runId,
      attemptId: steer.attemptId, effectId, outcome, messageId: refs.messageId ?? null,
      queuedMessageId: refs.queuedMessageId ?? null } };
    this.events.commit({ actorId: "runtime", commandId: `steer-settled:${effectId}`,
      projectId: target.projectId, threadId: target.threadId, command: event,
      expectedRevision: this.events.revision(target.threadId), events: [event], result: null }, () => {
      this.settleEffectRow(effectId, failureCode);
    });
    for (const listener of Array.from(this.steerSettledListeners)) {
      try {
        listener({ effectId, runId: steer.runId, attemptId: steer.attemptId, outcome });
      } catch {
        // Steer-settlement observers must never fail an already-committed settlement.
      }
    }
  }

  recordSteerRead(input: {
    conversationId: string;
    projectId: string;
    runId: string;
    attemptId: string;
    effectId: string;
    readAt?: string;
  }): boolean {
    const steer = this.steer(input.effectId);
    if (!steer || steer.runId !== input.runId || steer.attemptId !== input.attemptId
      || steer.state !== "settled" || steer.outcome !== "accepted") return false;
    if (steer.readAt !== null) return false;
    const readAt = input.readAt ?? this.clock();
    const event: OrchestrationDomainEvent = {
      type: "run-control.steer-read",
      payload: { runId: input.runId, attemptId: input.attemptId, effectId: input.effectId, readAt },
    };
    const committed = this.events.commit({
      actorId: "runtime",
      commandId: `steer-read:${input.effectId}`,
      projectId: input.projectId,
      threadId: input.conversationId,
      command: event,
      expectedRevision: this.events.revision(input.conversationId),
      events: [event],
      result: null,
    });
    return !committed.replayed;
  }

  listUnreadAcceptedSteers(runId: string): RunSteer[] {
    const target = this.target(runId);
    if (!target) return [];
    const rows = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE kind = ? AND thread_id = ?
        AND json_extract(payload_json, '$.runId') = ?
        AND json_extract(payload_json, '$.state') = 'settled'
        AND json_extract(payload_json, '$.outcome') = 'accepted'
        AND json_extract(payload_json, '$.readAt') IS NULL
      ORDER BY json_extract(payload_json, '$.requestedAt'), revision, id`)
      .all(RUN_STEER_PROJECTION, target.threadId, runId) as { payload_json: string }[];
    return rows.map(({ payload_json }) => runSteerSchema.parse(JSON.parse(payload_json)));
  }

  unsettledSteersBefore(effectId: string): string[] {
    const effect = this.effects.get(effectId);
    return effect ? this.effects.unsettledBefore(effect.threadId, effect.sequence, ["provider.steer"]) : [];
  }

  unsettledSteers(threadId: string): string[] {
    return this.effects.unsettledBefore(threadId, Number.MAX_SAFE_INTEGER, ["provider.steer"]);
  }

  async awaitSettled(effectIds: readonly string[], deadlineAt: number): Promise<boolean> {
    if (effectIds.length === 0) return true;
    const isSettled = (id: string): boolean => {
      const row = this.effects.get(id);
      return !row || (row.state !== "pending" && row.state !== "running");
    };
    if (effectIds.every(isSettled)) return true;
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    if (remainingMs === 0) return false;
    if (this.effectRuntime?.running) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
        timer.unref?.();
      });
      try {
        return await Promise.race([
          Promise.all(effectIds.map((id) => this.effectRuntime!.awaitSettled(id))).then(() => true, () => false),
          expired,
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return await new Promise<boolean>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      const finish = (settled: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe?.();
        resolve(settled);
      };
      const check = (): void => {
        try {
          if (effectIds.every(isSettled)) finish(true);
        } catch {
          finish(false);
        }
      };
      unsubscribe = this.effects.subscribe(check);
      poll = setInterval(check, 25);
      poll.unref?.();
      timer = setTimeout(() => finish(false), remainingMs);
      timer.unref?.();
      check();
    });
  }

  private escalation(target: RunControlTarget, cause: RunInterruptEscalationCause): OrchestrationDomainEvent {
    return { type: "run-control.interrupt-escalated",
      payload: { runId: target.runId, attemptId: target.attemptId, cause, at: this.clock() } };
  }

  private controlEffect(
    id: string,
    eventIndex: number,
    kind: "provider.interrupt" | "provider.steer",
    target: RunControlTarget,
    queuedMessageId?: string,
  ) {
    return {
      id,
      eventIndex,
      kind,
      replayPolicy: ORCHESTRATION_EFFECT_KINDS[kind].replayPolicy,
      payload: {
        runId: target.runId,
        attemptId: target.attemptId,
        turnId: target.turnId,
        ...(queuedMessageId !== undefined ? { queuedMessageId } : {}),
      },
    };
  }

  private settleEffectRow(effectId: string, failureCode: string | null): void {
    const current = this.effects.get(effectId);
    if (!current) return;
    if (current.state === "running" && current.claimId !== null) {
      this.effects.settle(current, failureCode === null ? { kind: "succeeded" } : { kind: "failed", code: failureCode });
    } else if (current.state === "pending") {
      this.effects.retirePending(effectId, failureCode ?? "control-settled");
    }
  }
}

function normalizeInterruptReason(reason: string | null | undefined): string | null | undefined {
  if (reason === undefined) return undefined;
  if (reason === null) return null;
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, MAX_RUN_INTERRUPT_REASON_CHARS).join("");
}
