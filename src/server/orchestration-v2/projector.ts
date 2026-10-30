import {
  orchestrationAttemptSchema,
  orchestrationDomainEventSchema,
  orchestrationRunSchema,
  orchestrationThreadSchema,
} from "../../shared/orchestration-v2";
import { canTransitionAgentTurnStatus, isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { agentTurnStatusForRunState } from "../../shared/run-state";
import { durableJson } from "./json";
import { projectBackingEvent } from "./backing-projector";
import { projectNativeBoundary } from "./native-boundary-projector";
import { projectForkEvent } from "./fork-projector";
import { projectNativeControl } from "./native-control-projector";
import { projectHistoryEvent } from "./history-projector";
import { projectMergeBackEvent } from "./merge-back-projector";
import { OrchestrationConflict, type ProjectEvent, type ProjectionWrite } from "./types";

export const projectOrchestrationEvent: ProjectEvent = (envelope, read) => {
  const event = orchestrationDomainEventSchema.parse({ type: envelope.type, payload: envelope.payload });
  const existingThread = read("thread", envelope.threadId);
  if (event.type === "thread.registered") {
    if (existingThread || event.payload.id !== envelope.threadId || event.payload.projectId !== envelope.projectId
      || event.payload.activeRunId !== null || event.payload.latestRunId !== null) {
      throw new OrchestrationConflict("scope-conflict");
    }
    return [{ kind: "thread", id: envelope.threadId, value: event.payload }];
  }
  if (!existingThread || existingThread.projectId !== envelope.projectId) throw new OrchestrationConflict("scope-conflict");
  const thread = orchestrationThreadSchema.parse(existingThread.value);
  if (event.type === "native.control-started" || event.type === "native.control-settled" || event.type === "fork.portable-selected") {
    return projectNativeControl(event, envelope, read);
  }
  if (event.type === "history.rolled-back" || event.type === "history.continuation-changed") {
    return projectHistoryEvent(event, envelope, read);
  }
  if (event.type === "merge-back.prepared" || event.type === "merge-back.changed") return projectMergeBackEvent(event, envelope, read);
  if (event.type === "provider.native-boundary") return projectNativeBoundary(event, envelope, read);
  if (event.type === "thread.forked" || event.type === "fork.history-part" || event.type === "fork.history-sealed") {
    return projectForkEvent(event, envelope, read);
  }
  if (event.type === "provider.backing-recorded" || event.type === "provider.backing-invalidated" || event.type === "provider.session-cleared"
    || event.type === "provider.backing-rewound"
    || event.type === "context.handoff-prepared" || event.type === "context.handoff-state-changed") {
    return projectBackingEvent(event, envelope, read);
  }
  if (event.type === "thread.configured") {
    if (thread.activeRunId !== null) throw new OrchestrationConflict("revision-conflict");
    return [{ kind: "thread", id: thread.id, value: { ...thread, ...event.payload, updatedAt: envelope.createdAt } }];
  }
  if (event.type === "run.accepted") {
    const { run, attempt } = event.payload;
    if (thread.latestRunId) {
      const previousRun = read("run", thread.latestRunId);
      if (previousRun) {
        const prior = orchestrationRunSchema.parse(previousRun.value);
        const previousAttempt = read("attempt", prior.attemptId);
        if (previousAttempt) {
          const cleanup = orchestrationAttemptSchema.parse(previousAttempt.value).cleanup;
          if (cleanup === "pending" || cleanup === "unconfirmed") throw new OrchestrationConflict("cleanup-pending");
        }
      }
    }
    if (thread.activeRunId !== null || read("run", run.id) || read("attempt", attempt.id)
      || run.threadId !== thread.id || run.projectId !== thread.projectId
      || run.workspaceKey !== thread.workspaceKey || run.providerId !== thread.providerId
      || durableJson(run.selection) !== durableJson(thread.selection)
      || run.status !== "queued" || run.executionState !== "queued" || run.providerState !== null
      || run.stateRevision !== 0 || run.startedAt !== null || run.completedAt !== null
      || run.terminalMessageId !== null || run.attemptId !== attempt.id
      || attempt.runId !== run.id || attempt.turnId !== run.turnId || attempt.threadId !== thread.id
      || attempt.providerInstanceId !== run.providerInstanceId || attempt.status !== "queued"
      || attempt.cleanup !== "not-started" || attempt.interruptRequestedAt !== null) {
      throw new OrchestrationConflict("scope-conflict");
    }
    return [
      { kind: "run", id: run.id, value: run },
      { kind: "attempt", id: attempt.id, value: attempt },
      { kind: "thread", id: thread.id, value: { ...thread, activeRunId: run.id, latestRunId: run.id, updatedAt: envelope.createdAt } },
    ];
  }
  const runRow = read("run", event.payload.runId);
  const attemptRow = read("attempt", event.payload.attemptId);
  if (!runRow || !attemptRow || runRow.threadId !== thread.id || attemptRow.threadId !== thread.id) {
    throw new OrchestrationConflict("scope-conflict");
  }
  const run = orchestrationRunSchema.parse(runRow.value);
  const attempt = orchestrationAttemptSchema.parse(attemptRow.value);
  if (run.attemptId !== attempt.id || attempt.runId !== run.id) throw new OrchestrationConflict("scope-conflict");
  switch (event.type) {
    case "run.attempt-replaced": {
      const replacement = event.payload.replacement;
      if (isAgentTurnTerminalStatus(run.status) || attempt.cleanup !== "confirmed"
        || read("attempt", replacement.id) || replacement.id === attempt.id
        || replacement.runId !== run.id || replacement.threadId !== run.threadId
        || replacement.turnId !== run.turnId || replacement.providerInstanceId !== run.providerInstanceId
        || replacement.status !== run.status || replacement.cleanup !== "pending"
        || replacement.interruptRequestedAt !== null) throw new OrchestrationConflict("scope-conflict");
      return [
        { kind: "run", id: run.id, value: { ...run, attemptId: replacement.id } },
        { kind: "attempt", id: replacement.id, value: replacement },
      ];
    }
    case "run.status-changed": {
      const payload = event.payload;
      if (!canTransitionAgentTurnStatus(run.status, payload.status)
        || agentTurnStatusForRunState(payload.executionState) !== payload.status
        || payload.stateRevision < run.stateRevision
        || ((run.executionState !== payload.executionState || run.providerState !== payload.providerState)
          && payload.stateRevision <= run.stateRevision)
        || (run.startedAt !== null && payload.startedAt !== run.startedAt)
        || (run.completedAt !== null && payload.completedAt !== run.completedAt)
        || (isAgentTurnTerminalStatus(payload.status) !== (payload.completedAt !== null))) {
        throw new OrchestrationConflict("revision-conflict");
      }
      const terminal = isAgentTurnTerminalStatus(payload.status);
      const writes: ProjectionWrite[] = [
        { kind: "run", id: run.id, value: { ...run,
          status: payload.status, executionState: payload.executionState, providerState: payload.providerState,
          stateRevision: payload.stateRevision, startedAt: payload.startedAt,
          completedAt: payload.completedAt, terminalMessageId: payload.terminalMessageId } },
        { kind: "attempt", id: attempt.id, value: { ...attempt, status: payload.status,
          nativeSessionId: payload.nativeSessionId ?? attempt.nativeSessionId } },
      ];
      if (thread.activeRunId === run.id && terminal) writes.push({ kind: "thread", id: thread.id,
        value: { ...thread, activeRunId: null, updatedAt: envelope.createdAt } });
      return writes;
    }
    case "attempt.interrupt-requested":
      if (isAgentTurnTerminalStatus(run.status)) throw new OrchestrationConflict("revision-conflict");
      return [{ kind: "attempt", id: attempt.id, value: { ...attempt,
        interruptRequestedAt: attempt.interruptRequestedAt ?? envelope.createdAt } }];
    case "attempt.cleanup-changed":
      if (attempt.cleanup === "confirmed" && event.payload.cleanup !== "confirmed") {
        throw new OrchestrationConflict("revision-conflict");
      }
      return [{ kind: "attempt", id: attempt.id, value: { ...attempt, cleanup: event.payload.cleanup } }];
  }
};
