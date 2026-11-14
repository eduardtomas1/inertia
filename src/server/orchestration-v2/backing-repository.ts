import type Database from "better-sqlite3";

import type { AgentTurn, ContinuationIdentity } from "../../shared/contracts";
import {
  MAX_BACKING_COVERAGE_ITEMS, contextHandoffSchema, providerBackingSchema,
  type ContextHandoff, type OrchestrationBackingEvent, type PreparedContextHandoff, type ProviderBacking,
} from "../../shared/orchestration-backings";
import { orchestrationAttemptSchema, orchestrationRunSchema, type OrchestrationRun } from "../../shared/orchestration-v2";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { versionedContinuationIdentitySchema } from "../../shared/model-routing";
import { nativeControlSchema } from "../../shared/orchestration-native-control";
import { staleAttemptObservation, type AttemptObserver, type StaleAttemptObservation } from "./attempt-fence";
import { relocatedBackingId } from "./backing-projector";
import type { OrchestrationEventStore } from "./event-store";
import { commandFingerprint, durableJson } from "./json";
import { providerInstanceId } from "./provider-instance";
import { OrchestrationConflict } from "./types";

const UNCLEAN_RECOVERY_REASONS = new Set(["runtime-restart", "runtime-crash"]);

export class ProviderBackingRepository {
  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore) {}

  get(id: string): ProviderBacking | null {
    const row = this.events.projection("provider-backing", id);
    return row ? providerBackingSchema.parse(row.value) : null;
  }

  /** Newest first. A native rewind writes the retired and the new backing in one event; the live one wins the tie. */
  find(input: { threadId: string; providerId: string; workspaceKey: string; identity: ContinuationIdentity;
    nativeSessionId?: string }): ProviderBacking | null {
    const rows = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE kind = 'provider-backing' AND thread_id = ?
        AND json_extract(payload_json, '$.providerInstanceId') = ?
        AND json_extract(payload_json, '$.workspaceKey') = ?
      ORDER BY revision DESC, json_extract(payload_json, '$.status') = 'retired', id LIMIT 64`)
      .all(input.threadId, providerInstanceId(input.providerId, input.identity), input.workspaceKey) as { payload_json: string }[];
    for (const row of rows) {
      const backing = providerBackingSchema.parse(JSON.parse(row.payload_json));
      if (input.nativeSessionId === undefined || backing.nativeSessionId === input.nativeSessionId) return backing;
    }
    return null;
  }

  /**
   * The chat's current native conversation for a provider instance: the newest
   * backing that is not retired, in any checkout. T3 keeps one current native
   * conversation per provider thread and resumes it wherever the thread runs.
   */
  current(input: { threadId: string; providerId: string; identity: ContinuationIdentity }): ProviderBacking | null {
    const row = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE kind = 'provider-backing' AND thread_id = ?
        AND json_extract(payload_json, '$.providerInstanceId') = ?
        AND json_extract(payload_json, '$.status') <> 'retired'
      ORDER BY revision DESC, id LIMIT 1`)
      .get(input.threadId, providerInstanceId(input.providerId, input.identity)) as { payload_json: string } | undefined;
    return row ? providerBackingSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  /** Whether this native session's backing was retired in any checkout: it must not be resumed again. */
  sessionRetired(input: { threadId: string; providerId: string; identity: ContinuationIdentity; nativeSessionId: string }): boolean {
    return this.database.prepare(`SELECT 1 FROM orchestration_v2_entities
      WHERE kind = 'provider-backing' AND thread_id = ?
        AND json_extract(payload_json, '$.providerInstanceId') = ?
        AND json_extract(payload_json, '$.nativeSessionId') = ?
        AND json_extract(payload_json, '$.status') = 'retired' LIMIT 1`)
      .get(input.threadId, providerInstanceId(input.providerId, input.identity), input.nativeSessionId) !== undefined;
  }

  /**
   * The checkout a native session without a backing last ran in, as far as
   * V2 recorded it: the newest run whose turn ended on the session, else the
   * native fork that created it. Null when nothing records it, as for a
   * session last used by a turn from before V2 runs.
   */
  sessionWorkspaceKey(threadId: string, nativeSessionId: string): string | null {
    const run = this.database.prepare(`SELECT json_extract(run.payload_json, '$.workspaceKey') AS workspace_key
      FROM agent_turns AS turn JOIN orchestration_v2_entities AS run ON run.kind = 'run' AND run.id = turn.run_id
      WHERE turn.conversation_id = ? AND turn.provider_session_after = ?
      ORDER BY turn.requested_at DESC, turn.rowid DESC LIMIT 1`).get(threadId, nativeSessionId) as
      { workspace_key: string | null } | undefined;
    if (run?.workspace_key) return run.workspace_key;
    const row = this.events.projection("fork-native-backing", threadId);
    const fork = row ? nativeControlSchema.parse(row.value) : null;
    return fork?.state === "completed" && fork.backing?.nativeConversationId === nativeSessionId
      ? fork.targetWorkspaceKey : null;
  }

  /**
   * The relocation event for a run admitted to resume `source`'s native session
   * in another checkout, checked against the run's own identity. It commits in
   * the admission, before the run's handoff.
   */
  relocation(run: { id: string; attemptId: string; threadId: string; providerInstanceId: string; workspaceKey: string },
    fromBackingId: string, nativeSessionId: string | null): OrchestrationBackingEvent {
    const source = this.get(fromBackingId);
    if (!source || source.threadId !== run.threadId || source.providerInstanceId !== run.providerInstanceId
      || source.workspaceKey === run.workspaceKey || source.nativeSessionId !== nativeSessionId
      || source.status !== "ready" || !source.coverageComplete) throw new OrchestrationConflict("revision-conflict");
    return { type: "provider.backing-relocated", payload: { runId: run.id, attemptId: run.attemptId, fromBackingId,
      backingId: relocatedBackingId(source, run.workspaceKey), workspaceKey: run.workspaceKey } };
  }

  handoff(runId: string): ContextHandoff | null {
    const run = this.run(runId);
    if (!run) return null;
    const row = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE thread_id = ? AND kind = 'context-handoff' AND json_extract(payload_json, '$.runId') = ?
      ORDER BY revision DESC LIMIT 1`).get(run.threadId, run.id) as { payload_json: string } | undefined;
    return row ? contextHandoffSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  /**
   * The latest turn that was not settled as not delivered. The provider
   * received nothing for such a turn, so it did not move the conversation
   * onto its route. Looks back over at most 16 turns.
   */
  deliveredRouteTurnId(threadId: string): string | null {
    const rows = this.database.prepare(`SELECT turn.id,
        json_extract(run.payload_json, '$.delivery') AS delivery FROM agent_turns AS turn
      LEFT JOIN orchestration_v2_entities AS run ON run.kind = 'run' AND run.id = turn.run_id
      WHERE turn.conversation_id = ? ORDER BY turn.requested_at DESC, turn.id DESC LIMIT 16`)
      .all(threadId) as { id: string; delivery: string | null }[];
    return rows.find(({ delivery }) => delivery !== "not-delivered")?.id ?? rows[0]?.id ?? null;
  }

  /** `relocatedFrom`: the run relocates this backing first, so its target is not projected yet. */
  preparation(runId: string, attemptId: string, threadId: string, requestedAt: string,
    prepared: PreparedContextHandoff, relocatedFrom?: ProviderBacking): OrchestrationBackingEvent {
    const target = prepared.targetBackingId ? this.get(prepared.targetBackingId) ?? relocatedFrom ?? null : null;
    const selection = { runId, attemptId, targetBackingId: prepared.targetBackingId, itemIds: [...prepared.itemIds] };
    const omitted = prepared.omittedItemIds?.length ? { omittedItemIds: [...prepared.omittedItemIds] } : null;
    return { type: "context.handoff-prepared", payload: {
      id: `handoff:${commandFingerprint(omitted ? { ...selection, ...omitted } : selection)}`,
      runId, attemptId, threadId, itemIds: selection.itemIds, ...omitted,
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
          status: handoff?.state === "prepared" ? "uncertain" : row.status }, run.id, run.attemptId, row);
      }
    }).immediate();
  }

  observeSession(turn: AgentTurn, nativeSessionId: string, observer?: AttemptObserver): StaleAttemptObservation | null {
    const run = this.run(turn.runId);
    if (!run) return null;
    const stale = staleAttemptObservation(this.events, run, observer);
    if (stale) return stale;
    // A relocated backing has its own id, so look the session's row up rather than derive its id.
    const previous = this.latest(run.threadId, run.providerInstanceId, run.workspaceKey, nativeSessionId);
    if (previous?.status === "retired") return null;
    const id = previous?.id ?? commandFingerprint({ threadId: run.threadId, instanceId: run.providerInstanceId,
      workspaceKey: run.workspaceKey, nativeSessionId });
    const timestamp = new Date().toISOString();
    const handoff = this.handoff(run.id);
    const inherited = previous ? null : this.nativeForkCoverage(run.threadId, run.providerInstanceId, nativeSessionId);
    const moved = previous || inherited ? [] : this.movedBackings(run.threadId, run.providerInstanceId, run.workspaceKey, nativeSessionId);
    const [carried] = moved;
    const status = previous?.lastRunId === run.id ? previous.status
      : handoff?.state === "dispatching" || carried?.status === "uncertain" ? "uncertain" : "ready";
    this.database.transaction(() => {
      for (const backing of moved) this.invalidate(backing, "workspace-changed");
      this.record({ id, threadId: run.threadId, projectId: run.projectId, providerId: run.providerId,
        providerInstanceId: run.providerInstanceId, workspaceKey: run.workspaceKey, nativeSessionId,
        continuationIdentity: versionedContinuationIdentitySchema.parse(turn.continuationIdentity), selection: run.selection,
        lastRunId: run.id, lastTurnId: run.turnId, status,
        coveredItemIds: previous?.coveredItemIds ?? inherited?.ids ?? carried?.coveredItemIds ?? [],
        coverageComplete: previous?.coverageComplete ?? inherited?.complete ?? carried?.coverageComplete ?? true,
        createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp }, run.id, run.attemptId);
    }).immediate();
    return null;
  }

  private latest(threadId: string, instanceId: string, workspaceKey: string, nativeSessionId: string): ProviderBacking | null {
    const row = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE kind = 'provider-backing' AND thread_id = ?
        AND json_extract(payload_json, '$.providerInstanceId') = ?
        AND json_extract(payload_json, '$.workspaceKey') = ?
        AND json_extract(payload_json, '$.nativeSessionId') = ?
      ORDER BY revision DESC, json_extract(payload_json, '$.status') = 'retired', id LIMIT 1`)
      .get(threadId, instanceId, workspaceKey, nativeSessionId) as { payload_json: string } | undefined;
    return row ? providerBackingSchema.parse(JSON.parse(row.payload_json)) : null;
  }

  private movedBackings(threadId: string, instanceId: string, workspaceKey: string, nativeSessionId: string): ProviderBacking[] {
    const rows = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE kind = 'provider-backing' AND thread_id = ?
        AND json_extract(payload_json, '$.providerInstanceId') = ?
        AND json_extract(payload_json, '$.nativeSessionId') = ?
        AND json_extract(payload_json, '$.workspaceKey') <> ?
        AND json_extract(payload_json, '$.status') <> 'retired'
      ORDER BY revision DESC LIMIT 64`).all(threadId, instanceId, nativeSessionId, workspaceKey) as { payload_json: string }[];
    return rows.map((row) => providerBackingSchema.parse(JSON.parse(row.payload_json)));
  }

  private nativeForkCoverage(threadId: string, instanceId: string, nativeSessionId: string) {
    const row = this.events.projection("fork-native-backing", threadId);
    if (!row) return null;
    const fork = nativeControlSchema.parse(row.value);
    // Inherited coverage belongs to the native conversation, not to a checkout (T3 keys coverage by native thread):
    // a fork moved before its first send keeps it when its harness resumes there.
    if (fork.state !== "completed" || fork.request.source.identity.providerInstanceId !== instanceId
      || fork.backing?.nativeConversationId !== nativeSessionId) return null;
    const items = this.database.prepare(`SELECT id FROM orchestration_v2_entities WHERE kind = 'fork-history'
      AND thread_id = ? AND json_extract(payload_json, '$.part') = 0 ORDER BY revision LIMIT ?`)
      .all(threadId, MAX_BACKING_COVERAGE_ITEMS + 1) as { id: string }[];
    return { ids: items.slice(0, MAX_BACKING_COVERAGE_ITEMS).map(({ id }) => id), complete: items.length <= MAX_BACKING_COVERAGE_ITEMS };
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

  /**
   * `undelivered`: the provider refused before anything reached the session.
   * The handoff is abandoned rather than uncertain, the backing returns to its
   * state before this run's dispatch, and the turn adds nothing to its coverage.
   */
  settle(turn: AgentTurn, undelivered = false): void {
    if (!isAgentTurnTerminalStatus(turn.status)) return;
    const run = this.run(turn.runId);
    if (!run) return;
    if (turn.providerSessionAfter) this.observeSession(turn, turn.providerSessionAfter);
    if (turn.status === "completed") this.acknowledge(run.id);
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    const backing = attempt.nativeSessionId ? this.find({ threadId: run.threadId, providerId: run.providerId,
      workspaceKey: run.workspaceKey, identity: turn.continuationIdentity, nativeSessionId: attempt.nativeSessionId }) : null;
    const handoff = this.handoff(run.id);
    if (handoff?.state === "prepared" || (undelivered && handoff?.state === "dispatching")) {
      this.changeHandoff(handoff, "abandoned");
    } else if (handoff?.state === "dispatching") this.changeHandoff(handoff, "uncertain", backing);
    if (backing?.lastRunId === run.id && UNCLEAN_RECOVERY_REASONS.has(turn.terminalReason ?? "")) {
      this.invalidate(backing, "uncertain-delivery");
      return;
    }
    if (undelivered) {
      if (backing?.lastRunId === run.id && backing.status !== "retired") this.restoreBeforeRun(backing, run.id);
      return;
    }
    if (!backing || backing.lastRunId !== run.id || backing.status !== "ready") return;
    const rows = this.database.prepare(`SELECT id FROM messages WHERE conversation_id = ? AND turn_id = ?
      AND role IN ('user','assistant') ORDER BY created_at, rowid LIMIT ?`)
      .all(run.threadId, run.turnId, MAX_BACKING_COVERAGE_ITEMS + 1) as { id: string }[];
    const coverage = [...new Set([...backing.coveredItemIds,
      ...(handoff?.state === "delivered" ? [...handoff.itemIds, ...handoff.omittedItemIds ?? []] : []),
      ...rows.map(({ id }) => id)])];
    this.record({ ...backing, coveredItemIds: coverage.slice(-MAX_BACKING_COVERAGE_ITEMS),
      coverageComplete: backing.coverageComplete && coverage.length <= MAX_BACKING_COVERAGE_ITEMS }, run.id, run.attemptId);
  }

  /**
   * Dispatch moved the backing to this run (and to `uncertain` for a prepared
   * handoff) and kept its earlier value in that record. Restore that value, so
   * the next turn sees the backing it would have seen without this run. Unlike
   * a record, a restore touches no attempt.
   */
  private restoreBeforeRun(backing: ProviderBacking, runId: string): void {
    const row = this.database.prepare(`SELECT payload_json FROM orchestration_v2_events
      WHERE thread_id = ? AND type = 'provider.backing-recorded' AND json_extract(payload_json, '$.runId') = ?
        AND json_extract(payload_json, '$.backing.id') = ? AND json_extract(payload_json, '$.beforeDispatch') IS NOT NULL
      ORDER BY revision DESC LIMIT 1`).get(backing.threadId, runId, backing.id) as { payload_json: string } | undefined;
    if (!row) return;
    const before = providerBackingSchema.parse((JSON.parse(row.payload_json) as { beforeDispatch: unknown }).beforeDispatch);
    if (before.status === "retired" || before.lastRunId === runId) return;
    this.commit(backing.threadId, backing.projectId, { type: "provider.backing-restored", payload: { runId,
      backing: providerBackingSchema.parse({ ...before, coveredItemIds: backing.coveredItemIds,
        coverageComplete: backing.coverageComplete, updatedAt: new Date().toISOString() }) } });
  }

  invalidate(backing: ProviderBacking, reason: Extract<OrchestrationBackingEvent,
    { type: "provider.backing-invalidated" }>["payload"]["reason"]): void {
    if (backing.status === "retired") return;
    this.commit(backing.threadId, backing.projectId, { type: "provider.backing-invalidated", payload: { backingId: backing.id, reason } });
  }

  /**
   * Moves a run off a rejected native session inside one transaction: the
   * pending handoff is abandoned, the session's backing retired, the
   * compatibility restart applied and the attempt replaced, and the restored
   * history is prepared for the replacement attempt. The replaced attempt
   * keeps the native refs it observed.
   */
  restart<T>(turn: AgentTurn, expectedSessionId: string, prepared: PreparedContextHandoff | undefined, restart: () => T,
    replaceAttempt: (run: OrchestrationRun) => string): T {
    return this.database.transaction(() => {
      const run = this.run(turn.runId);
      if (!run) return restart();
      const backing = this.find({ threadId: run.threadId, providerId: run.providerId, workspaceKey: run.workspaceKey,
        identity: turn.continuationIdentity, nativeSessionId: expectedSessionId });
      const handoff = this.handoff(run.id);
      if (handoff?.state === "prepared" || handoff?.state === "dispatching") this.changeHandoff(handoff, "abandoned");
      if (backing) this.invalidate(backing, "native-resume-failed");
      const result = restart();
      const attemptId = replaceAttempt(run);
      if (prepared) {
        this.commit(run.threadId, run.projectId, this.preparation(run.id, attemptId,
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

  private record(backing: ProviderBacking, runId: string, attemptId: string, beforeDispatch?: ProviderBacking): void {
    const previous = this.get(backing.id);
    if (previous && durableJson({ ...backing, updatedAt: previous.updatedAt }) === durableJson(previous)) return;
    const value = providerBackingSchema.parse({ ...backing, updatedAt: new Date().toISOString() });
    this.commit(backing.threadId, backing.projectId, { type: "provider.backing-recorded",
      payload: { backing: value, runId, attemptId, ...(beforeDispatch ? { beforeDispatch } : {}) } });
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
