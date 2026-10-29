import type Database from "better-sqlite3";

import type { AgentTurn, ContinuationIdentity } from "../../shared/contracts";
import {
  MAX_BACKING_COVERAGE_ITEMS, contextHandoffSchema, providerBackingSchema,
  type ContextHandoff, type OrchestrationBackingEvent, type PreparedContextHandoff, type ProviderBacking,
} from "../../shared/orchestration-backings";
import { orchestrationAttemptSchema, orchestrationRunSchema } from "../../shared/orchestration-v2";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { versionedContinuationIdentitySchema } from "../../shared/model-routing";
import type { OrchestrationEventStore } from "./event-store";
import { commandFingerprint, durableJson } from "./json";
import { providerInstanceId } from "./provider-instance";

export class ProviderBackingRepository {
  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore) {}

  get(id: string): ProviderBacking | null {
    const row = this.events.projection("provider-backing", id);
    return row ? providerBackingSchema.parse(row.value) : null;
  }

  find(input: { threadId: string; providerId: string; workspaceKey: string; identity: ContinuationIdentity;
    nativeSessionId?: string }): ProviderBacking | null {
    const rows = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE kind = 'provider-backing' AND thread_id = ?
        AND json_extract(payload_json, '$.providerInstanceId') = ?
        AND json_extract(payload_json, '$.workspaceKey') = ?
      ORDER BY revision DESC LIMIT 64`).all(input.threadId, providerInstanceId(input.providerId, input.identity), input.workspaceKey) as { payload_json: string }[];
    for (const row of rows) {
      const backing = providerBackingSchema.parse(JSON.parse(row.payload_json));
      if (input.nativeSessionId === undefined || backing.nativeSessionId === input.nativeSessionId) return backing;
    }
    return null;
  }

  handoff(runId: string): ContextHandoff | null {
    const run = this.run(runId);
    if (!run) return null;
    const row = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE thread_id = ? AND kind = 'context-handoff' AND json_extract(payload_json, '$.runId') = ?
      ORDER BY revision DESC LIMIT 1`).get(run.threadId, run.id) as { payload_json: string } | undefined;
    return row ? contextHandoffSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  preparation(runId: string, attemptId: string, threadId: string, requestedAt: string,
    prepared: PreparedContextHandoff): OrchestrationBackingEvent {
    const target = prepared.targetBackingId ? this.get(prepared.targetBackingId) : null;
    return { type: "context.handoff-prepared", payload: {
      id: `handoff:${commandFingerprint({ runId, attemptId, targetBackingId: prepared.targetBackingId, itemIds: prepared.itemIds })}`,
      runId, attemptId, threadId, itemIds: [...prepared.itemIds],
      targetBackingId: prepared.targetBackingId, nativeSessionId: target?.nativeSessionId ?? null,
      method: "inline", state: "prepared", createdAt: requestedAt, updatedAt: requestedAt,
    } };
  }

  /** Must commit before handing a request to a native transport. */
  dispatch(runId: string): void {
    this.database.transaction(() => {
      const handoff = this.handoff(runId);
      if (handoff?.state === "prepared") this.changeHandoff(handoff, "dispatching");
      const run = this.run(runId);
      if (!run) return;
      const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
      if (attempt.nativeSessionId) {
        const row = this.find({ threadId: run.threadId, providerId: run.providerId, workspaceKey: run.workspaceKey,
          identity: this.turnIdentity(run.turnId), nativeSessionId: attempt.nativeSessionId });
        if (row && row.status !== "retired") this.record({ ...row, lastRunId: run.id,
          lastTurnId: run.turnId, selection: run.selection,
          status: handoff?.state === "prepared" ? "uncertain" : row.status }, run.id, run.attemptId);
      }
    }).immediate();
  }

  observeSession(turn: AgentTurn, nativeSessionId: string): void {
    const run = this.run(turn.runId);
    if (!run) return;
    const id = commandFingerprint({ threadId: run.threadId, instanceId: run.providerInstanceId,
      workspaceKey: run.workspaceKey, nativeSessionId });
    const previous = this.get(id);
    if (previous?.status === "retired") return;
    const timestamp = new Date().toISOString();
    const handoff = this.handoff(run.id);
    this.record({ id, threadId: run.threadId, projectId: run.projectId, providerId: run.providerId,
      providerInstanceId: run.providerInstanceId, workspaceKey: run.workspaceKey, nativeSessionId,
      continuationIdentity: versionedContinuationIdentitySchema.parse(turn.continuationIdentity), selection: run.selection,
      lastRunId: run.id, lastTurnId: run.turnId,
      status: previous?.lastRunId === run.id ? previous.status : handoff?.state === "dispatching" ? "uncertain" : "ready",
      coveredItemIds: previous?.coveredItemIds ?? [], coverageComplete: previous?.coverageComplete ?? true,
      createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp }, run.id, run.attemptId);
  }

  /** Provider output is evidence that a request reached the native session. */
  acknowledge(runId: string): void {
    const run = this.run(runId);
    if (!run) return;
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    const backing = attempt.nativeSessionId ? this.find({ threadId: run.threadId, providerId: run.providerId,
      workspaceKey: run.workspaceKey, identity: this.turnIdentity(run.turnId), nativeSessionId: attempt.nativeSessionId }) : null;
    if (!backing || backing.status === "retired" || backing.lastRunId !== run.id) return;
    this.database.transaction(() => {
      const handoff = this.handoff(run.id);
      if (handoff?.state === "dispatching") this.changeHandoff(handoff, "delivered", backing);
      if (backing.status !== "ready") this.record({ ...backing, status: "ready" }, run.id, run.attemptId);
    }).immediate();
  }

  settle(turn: AgentTurn): void {
    if (!isAgentTurnTerminalStatus(turn.status)) return;
    const run = this.run(turn.runId);
    if (!run) return;
    if (turn.providerSessionAfter) this.observeSession(turn, turn.providerSessionAfter);
    if (turn.status === "completed") this.acknowledge(run.id);
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    const backing = attempt.nativeSessionId ? this.find({ threadId: run.threadId, providerId: run.providerId,
      workspaceKey: run.workspaceKey, identity: turn.continuationIdentity, nativeSessionId: attempt.nativeSessionId }) : null;
    const handoff = this.handoff(run.id);
    if (handoff?.state === "prepared") this.changeHandoff(handoff, "abandoned");
    else if (handoff?.state === "dispatching") this.changeHandoff(handoff, "uncertain", backing);
    if (!backing || backing.lastRunId !== run.id || backing.status !== "ready") return;
    const rows = this.database.prepare(`SELECT id FROM messages WHERE conversation_id = ? AND turn_id = ?
      AND role IN ('user','assistant') ORDER BY created_at, rowid LIMIT ?`)
      .all(run.threadId, run.turnId, MAX_BACKING_COVERAGE_ITEMS + 1) as { id: string }[];
    const coverage = [...new Set([...backing.coveredItemIds,
      ...(handoff?.state === "delivered" ? handoff.itemIds : []), ...rows.map(({ id }) => id)])];
    this.record({ ...backing, coveredItemIds: coverage.slice(-MAX_BACKING_COVERAGE_ITEMS),
      coverageComplete: backing.coverageComplete && coverage.length <= MAX_BACKING_COVERAGE_ITEMS }, run.id, run.attemptId);
  }

  invalidate(backing: ProviderBacking, reason: Extract<OrchestrationBackingEvent,
    { type: "provider.backing-invalidated" }>["payload"]["reason"]): void {
    if (backing.status === "retired") return;
    this.commit(backing.threadId, backing.projectId, { type: "provider.backing-invalidated", payload: { backingId: backing.id, reason } });
  }

  restart<T>(turn: AgentTurn, expectedSessionId: string, prepared: PreparedContextHandoff | undefined, restart: () => T): T {
    return this.database.transaction(() => {
      const run = this.run(turn.runId);
      if (!run) return restart();
      const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
      const backing = this.find({ threadId: run.threadId, providerId: run.providerId, workspaceKey: run.workspaceKey,
        identity: turn.continuationIdentity, nativeSessionId: expectedSessionId });
      const handoff = this.handoff(run.id);
      if (handoff?.state === "prepared" || handoff?.state === "dispatching") this.changeHandoff(handoff, "abandoned");
      if (backing) this.invalidate(backing, "native-resume-failed");
      if (attempt.nativeSessionId === expectedSessionId) this.commit(run.threadId, run.projectId,
        { type: "provider.session-cleared", payload: { runId: run.id, attemptId: attempt.id, expectedNativeSessionId: expectedSessionId } });
      const result = restart();
      if (prepared) {
        this.commit(run.threadId, run.projectId, this.preparation(run.id, run.attemptId,
          run.threadId, new Date().toISOString(), { ...prepared, targetBackingId: null }));
        this.changeHandoff(this.handoff(run.id)!, "dispatching");
      }
      return result;
    }).immediate();
  }

  private turnIdentity(turnId: string): ContinuationIdentity {
    const row = this.database.prepare("SELECT continuation_identity_json FROM agent_turns WHERE id = ?").get(turnId) as { continuation_identity_json: string };
    return JSON.parse(row.continuation_identity_json) as ContinuationIdentity;
  }

  private run(runId: string) {
    const row = this.events.projection("run", runId);
    return row ? orchestrationRunSchema.parse(row.value) : null;
  }

  private record(backing: ProviderBacking, runId: string, attemptId: string): void {
    const previous = this.get(backing.id);
    if (previous && durableJson({ ...backing, updatedAt: previous.updatedAt }) === durableJson(previous)) return;
    const value = providerBackingSchema.parse({ ...backing, updatedAt: new Date().toISOString() });
    this.commit(backing.threadId, backing.projectId, { type: "provider.backing-recorded", payload: { backing: value, runId, attemptId } });
  }

  private changeHandoff(handoff: ContextHandoff, state: "dispatching" | "delivered" | "uncertain" | "abandoned",
    backing?: ProviderBacking | null): void {
    const run = this.run(handoff.runId)!;
    this.commit(handoff.threadId, run.projectId, { type: "context.handoff-state-changed", payload: {
      handoffId: handoff.id, runId: handoff.runId, attemptId: handoff.attemptId, state,
      targetBackingId: backing?.id ?? handoff.targetBackingId, nativeSessionId: backing?.nativeSessionId ?? handoff.nativeSessionId,
    } });
  }

  private commit(threadId: string, projectId: string, event: OrchestrationBackingEvent): void {
    this.events.commit({ actorId: "runtime", commandId: `backing:${commandFingerprint(event)}`,
      threadId, projectId, command: event, expectedRevision: this.events.revision(threadId), events: [event], result: null });
  }

}
