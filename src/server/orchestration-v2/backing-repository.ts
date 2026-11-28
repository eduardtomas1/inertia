import type Database from "better-sqlite3";

import type { AgentTurn, ContinuationIdentity } from "../../shared/contracts";
import {
  MAX_BACKING_COVERAGE_ITEMS, MAX_BACKING_UNCOVERED_ITEMS, contextHandoffSchema, providerBackingSchema,
  type BackingCoverage, type ContextHandoff, type InheritedCoverage, type OrchestrationBackingEvent,
  type PreparedContextHandoff, type ProviderBacking,
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
import { harnessDeclaresCapability } from "../provider/capability-manifest";
import { OrchestrationConflict } from "./types";

const UNCLEAN_RECOVERY_REASONS = new Set(["runtime-restart", "runtime-crash"]);

/** Pure N18 coverage predicate: exceptions win, then explicit IDs, then turn watermark or legacy flag. */
export function isItemCovered(
  backing: Pick<ProviderBacking, "coveredItemIds" | "coveredThroughOrdinal" | "uncoveredItemIds" | "legacyCovered">,
  itemId: string,
  turnOrdinal: number | null,
): boolean {
  if (backing.uncoveredItemIds?.includes(itemId)) return false;
  if (backing.coveredItemIds.includes(itemId)) return true;
  if (turnOrdinal !== null) {
    return backing.coveredThroughOrdinal !== undefined && turnOrdinal <= backing.coveredThroughOrdinal;
  }
  return backing.legacyCovered === true;
}

function optionalCoverageFields(coverage: Pick<
  BackingCoverage,
  "coveredThroughOrdinal" | "uncoveredItemIds" | "inheritedCoverage" | "legacyCovered"
>): Partial<Pick<ProviderBacking, "coveredThroughOrdinal" | "uncoveredItemIds" | "inheritedCoverage" | "legacyCovered">> {
  return {
    ...(coverage.coveredThroughOrdinal !== undefined ? { coveredThroughOrdinal: coverage.coveredThroughOrdinal } : {}),
    ...(coverage.uncoveredItemIds && coverage.uncoveredItemIds.length > 0 ? { uncoveredItemIds: coverage.uncoveredItemIds } : {}),
    ...(coverage.inheritedCoverage !== undefined ? { inheritedCoverage: coverage.inheritedCoverage } : {}),
    ...(coverage.legacyCovered === true ? { legacyCovered: true } : {}),
  };
}

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
   * The checkout a native session was created in, as far as V2 recorded it: the oldest run whose turn ended
   * on the session (a relocation never creates one), else the native fork that created it. Null when nothing
   * records it, as for a session last used by a turn from before V2 runs. A harness that keeps its native
   * store per checkout finds the session there (T3 `cursorStoreCwd`).
   */
  sessionOriginWorkspaceKey(threadId: string, nativeSessionId: string): string | null {
    return this.sessionCheckout(threadId, nativeSessionId, "ASC");
  }

  /**
   * The checkout a native session without a backing last ran in, as far as
   * V2 recorded it: the newest run whose turn ended on the session, else the
   * native fork that created it. Null when nothing records it, as for a
   * session last used by a turn from before V2 runs.
   */
  sessionWorkspaceKey(threadId: string, nativeSessionId: string): string | null {
    return this.sessionCheckout(threadId, nativeSessionId, "DESC");
  }

  private sessionCheckout(threadId: string, nativeSessionId: string, order: "ASC" | "DESC"): string | null {
    const run = this.database.prepare(`SELECT json_extract(run.payload_json, '$.workspaceKey') AS workspace_key
      FROM agent_turns AS turn JOIN orchestration_v2_entities AS run ON run.kind = 'run' AND run.id = turn.run_id
      WHERE turn.conversation_id = ? AND turn.provider_session_after = ?
      ORDER BY turn.requested_at ${order}, turn.rowid ${order} LIMIT 1`).get(threadId, nativeSessionId) as
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
   * onto its route. Null when no turn reached a provider: the switch any of
   * them attempted is still due. The walk follows the chat's
   * `(conversation_id, requested_at, id)` index newest first and stops at the
   * first delivered turn, so it is bounded by the chat's own turns; unaccepted
   * Codex starts can make that run longer than any fixed window. A
   * `prompt-not-delivered` turn counts as delivered: its injected history
   * reached the route. A turn whose provider dropped its prompt is
   * `not-delivered` (with `promptDropped`), so it does not count, as T3's
   * `lastDeliveredRunForProviderThread` skips a `promptDropped` turn.
   */
  deliveredRouteTurnId(threadId: string): string | null {
    const row = this.database.prepare(`SELECT turn.id FROM agent_turns AS turn
      LEFT JOIN orchestration_v2_entities AS run ON run.kind = 'run' AND run.id = turn.run_id
      WHERE turn.conversation_id = ?
        AND (run.payload_json IS NULL OR json_extract(run.payload_json, '$.delivery') IS NOT 'not-delivered')
      ORDER BY turn.requested_at DESC, turn.id DESC LIMIT 1`).get(threadId) as { id: string } | undefined;
    return row?.id ?? null;
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

  /**
   * The run's harness continues `nativeSessionId`, a copy of the resumed `fromNativeSessionId` made in the run's
   * checkout (Pi; T3 keeps the provider thread and repoints its native ref). The backing this run took over moves
   * to the copy with its coverage, and the attempt and the run's handoff follow it, before the session is observed.
   * Nothing is written unless the run's current attempt works on the resumed session's backing in its checkout.
   */
  forkSession(turn: AgentTurn, fromNativeSessionId: string, nativeSessionId: string, observer?: AttemptObserver): StaleAttemptObservation | null {
    if (fromNativeSessionId === nativeSessionId) return null;
    return this.database.transaction(() => {
      const run = this.run(turn.runId);
      if (!run) return null;
      const stale = staleAttemptObservation(this.events, run, observer);
      if (stale) return stale;
      const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
      const source = this.latest(run.threadId, run.providerInstanceId, run.workspaceKey, fromNativeSessionId);
      if (attempt.nativeSessionId !== fromNativeSessionId || !source || source.status === "retired" || source.lastRunId !== run.id
        || this.latest(run.threadId, run.providerInstanceId, run.workspaceKey, nativeSessionId)) return null;
      const handoff = this.handoff(run.id);
      const followed = handoff?.targetBackingId === source.id && (handoff.state === "prepared" || handoff.state === "dispatching");
      this.commit(run.threadId, run.projectId, { type: "provider.backing-forked", payload: { runId: run.id,
        attemptId: run.attemptId, backingId: source.id, fromNativeSessionId, nativeSessionId,
        handoffId: followed ? handoff.id : null } });
      return null;
    }).immediate();
  }

  /**
   * `forkedFrom`: the session the harness copied into `nativeSessionId` (see `forkSession`). When that session had
   * no backing to move (a native fork before its first send), the copy inherits the native fork's coverage.
   */
  observeSession(turn: AgentTurn, nativeSessionId: string, observer?: AttemptObserver, forkedFrom?: string): StaleAttemptObservation | null {
    return this.database.transaction(() => {
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
      const copied = forkedFrom !== undefined && forkedFrom !== nativeSessionId && turn.providerSessionBefore === forkedFrom
        ? forkedFrom : null;
      const inherited = previous ? null : this.nativeForkCoverage(run.threadId, run.providerInstanceId, nativeSessionId)
        ?? (copied ? this.nativeForkCoverage(run.threadId, run.providerInstanceId, copied) : null);
      const moved = previous || inherited ? [] : this.movedBackings(run.threadId, run.providerInstanceId, run.workspaceKey, nativeSessionId);
      const [carried] = moved;
      const status = previous?.lastRunId === run.id ? previous.status
        : handoff?.state === "dispatching" || carried?.status === "uncertain" ? "uncertain" : "ready";
      const watermark = previous
        ? optionalCoverageFields(previous)
        : inherited
          ? optionalCoverageFields(inherited)
          : carried
            ? optionalCoverageFields(carried)
            : {};
      for (const backing of moved) this.invalidate(backing, "workspace-changed");
      this.record({ id, threadId: run.threadId, projectId: run.projectId, providerId: run.providerId,
        providerInstanceId: run.providerInstanceId, workspaceKey: run.workspaceKey, nativeSessionId,
        continuationIdentity: versionedContinuationIdentitySchema.parse(turn.continuationIdentity), selection: run.selection,
        lastRunId: run.id, lastTurnId: run.turnId, status,
        coveredItemIds: previous?.coveredItemIds ?? (inherited ? [] : carried?.coveredItemIds ?? []),
        coverageComplete: previous?.coverageComplete ?? (inherited ? true : carried?.coverageComplete ?? true),
        ...watermark,
        createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp }, run.id, run.attemptId);
      return null;
    }).immediate();
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

  private nativeForkCoverage(threadId: string, instanceId: string, nativeSessionId: string): {
    inheritedCoverage: "complete";
  } | null {
    const row = this.events.projection("fork-native-backing", threadId);
    if (!row) return null;
    const fork = nativeControlSchema.parse(row.value);
    // Inherited coverage belongs to the native conversation, not to a checkout (T3 keys coverage by native thread):
    // a fork moved before its first send keeps it when its harness resumes there.
    if (fork.state !== "completed" || fork.request.source.identity.providerInstanceId !== instanceId
      || fork.backing?.nativeConversationId !== nativeSessionId) return null;
    return { inheritedCoverage: "complete" };
  }

  /** Provider output is evidence that a request reached the native session. */
  acknowledge(runId: string): void {
    this.database.transaction(() => {
      const run = this.run(runId);
      if (!run) return;
      const backing = this.attemptBacking(run);
      if (!backing || backing.status === "retired" || backing.lastRunId !== run.id) return;
      const handoff = this.handoff(run.id);
      // A native handoff is delivered only by the injection's own response, never by later output.
      if (handoff?.state === "dispatching" && handoff.method === "inline") this.changeHandoff(handoff, "delivered", backing);
      if (backing.status !== "ready") this.record({ ...backing, status: "ready" }, run.id, run.attemptId);
    }).immediate();
  }

  /**
   * Native history injection (T3 `deliverContextHandoffs`). `begin` commits before the request
   * (T3 `pending`): the dispatching handoff becomes `native`. `delivered` commits the provider's
   * acceptance before the turn starts (T3 `injected`); it readies the session's backing, so the
   * handoff's items are credited at settlement whatever the turn's outcome. `unsupported`: the
   * provider refused the method before changing history, so the handoff goes inline in the same
   * turn. Each returns false, writing nothing, unless the run's current attempt owns the handoff
   * in the expected state; a Stop already recorded on the attempt also refuses `begin`.
   */
  historyInjection(runId: string, attemptId: string, step: "begin" | "delivered" | "unsupported"): boolean {
    return this.database.transaction(() => {
      const run = this.run(runId);
      const handoff = run?.attemptId === attemptId ? this.handoff(runId) : null;
      if (!run || handoff?.attemptId !== attemptId || handoff.state !== "dispatching"
        || handoff.method !== (step === "begin" ? "inline" : "native")) return false;
      if (step === "begin") {
        const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", attemptId)?.value);
        // One injection per attempt: a handoff that already changed method (refused as unknown) stays inline.
        const changedMethod = this.database.prepare(`SELECT 1 FROM orchestration_v2_events
          WHERE thread_id = ? AND type = 'context.handoff-state-changed'
            AND json_extract(payload_json, '$.handoffId') = ? AND json_extract(payload_json, '$.method') IS NOT NULL LIMIT 1`)
          .get(run.threadId, handoff.id) !== undefined;
        if (attempt.interruptRequestedAt !== null || changedMethod) return false;
        this.changeHandoff(handoff, "dispatching", undefined, "native");
      } else if (step === "unsupported") {
        this.changeHandoff(handoff, "dispatching", undefined, "inline");
      } else {
        const found = this.attemptBacking(run);
        const backing = found && found.status !== "retired" && found.lastRunId === run.id ? found : null;
        this.changeHandoff(handoff, "delivered", backing, "native");
        if (backing && backing.status !== "ready") this.record({ ...backing, status: "ready" }, run.id, run.attemptId);
      }
      return true;
    }).immediate();
  }

  /**
   * `undelivered`: the provider refused before anything reached the session.
   * The handoff is abandoned rather than uncertain, the backing returns to its
   * state before this run's dispatch, and the turn adds nothing to its coverage.
   */
  /**
   * Whether the run's turn is known not to have reached its provider: the
   * harness reports turn acceptance (or the run's history was injected before
   * its turn), and nothing shows the provider accepted the turn. T3 counts a
   * run's items only with an accepted provider turn and resends missed runs
   * (`ProviderTurnStartService.ts:863-880`, `:1052-1118`).
   */
  unaccepted(turn: AgentTurn): boolean {
    const run = this.run(turn.runId);
    if (!run) return false;
    const handoff = this.handoff(run.id);
    return (this.historyInjected(handoff) || harnessDeclaresCapability(turn.harnessId, "turn-acceptance"))
      && !this.turnAccepted(turn, run, handoff);
  }

  /** Whether the run's restored history reached its session by injection. */
  historyInjected(handoff: ContextHandoff | null): boolean {
    return handoff?.state === "delivered" && handoff.method === "native";
  }

  /**
   * `unaccepted`: decided once by the caller (`unaccepted(turn)` before settlement), else here. `promptDropped`: the
   * provider dropped the turn's prompt (T3 `promptDropped`, passed with `unaccepted`), so an inline handoff its output
   * already delivered is abandoned too: it reached the provider only inside that prompt (T3 restores the handoffs it
   * sent to pending). The next run prepares a new one from the restored backing.
   * `unreadFollowUpMessageIds`: follow-ups the provider accepted but never read; the session never held them.
   */
  settle(turn: AgentTurn, undelivered = false, unacceptedTurn?: boolean, promptDropped = false,
    unreadFollowUpMessageIds: readonly string[] = []): void {
    if (!isAgentTurnTerminalStatus(turn.status)) return;
    const run = this.run(turn.runId);
    if (!run) return;
    if (turn.providerSessionAfter) this.observeSession(turn, turn.providerSessionAfter);
    if (turn.status === "completed") this.acknowledge(run.id);
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    const backing = attempt.nativeSessionId ? this.find({ threadId: run.threadId, providerId: run.providerId,
      workspaceKey: run.workspaceKey, identity: turn.continuationIdentity, nativeSessionId: attempt.nativeSessionId }) : null;
    const handoff = this.handoff(run.id);
    // Injection may have reached the session in part: never abandoned, and never resumed (T3: a `pending`
    // delivery on the current native thread makes the next turn start fresh with a full restore).
    const nativeUncertain = handoff?.state === "dispatching" && handoff.method === "native";
    const nativeDelivered = this.historyInjected(handoff);
    // Without acceptance evidence nothing but an injection reached the session: the prompt and an inline handoff
    // were not delivered (see `unaccepted`).
    const unaccepted = unacceptedTurn ?? ((nativeDelivered || harnessDeclaresCapability(turn.harnessId, "turn-acceptance"))
      && !this.turnAccepted(turn, run, handoff));
    const notDelivered = undelivered || (unaccepted && !nativeUncertain && !nativeDelivered);
    if (handoff?.state === "prepared" || (notDelivered && handoff?.state === "dispatching" && !nativeUncertain)
      || (promptDropped && notDelivered && handoff?.state === "delivered" && handoff.method === "inline")) {
      this.changeHandoff(handoff, "abandoned");
    } else if (handoff?.state === "dispatching") this.changeHandoff(handoff, "uncertain", backing);
    if (backing && (nativeUncertain
      || (backing.lastRunId === run.id && UNCLEAN_RECOVERY_REASONS.has(turn.terminalReason ?? "")))) {
      this.invalidate(backing, "uncertain-delivery");
      return;
    }
    if (notDelivered) {
      if (backing?.lastRunId === run.id && backing.status !== "retired") {
        this.restoreBeforeRun(backing, run.id, undelivered || promptDropped || backing.status === "uncertain");
      }
      return;
    }
    if (!backing || backing.lastRunId !== run.id || backing.status !== "ready") return;
    const nextCoverage = this.computeNextCoverage(backing, run, handoff, unaccepted, unreadFollowUpMessageIds);
    const {
      coveredThroughOrdinal: _c,
      uncoveredItemIds: _u,
      inheritedCoverage: _i,
      legacyCovered: _l,
      ...baseBacking
    } = backing;
    this.record({ ...baseBacking, ...nextCoverage }, run.id, run.attemptId);
  }

  private computeNextCoverage(
    backing: ProviderBacking,
    run: OrchestrationRun,
    handoff: ContextHandoff | null,
    unaccepted: boolean,
    unreadFollowUpMessageIds: readonly string[],
  ): Pick<ProviderBacking, "coveredItemIds" | "coverageComplete" | "coveredThroughOrdinal" | "uncoveredItemIds" | "inheritedCoverage" | "legacyCovered"> {
    const threadId = run.threadId;
    const covered = new Set<string>(backing.coveredItemIds);
    const uncovered = new Set<string>(backing.uncoveredItemIds ?? []);
    const unread = new Set<string>(unreadFollowUpMessageIds);
    const pendingUnread = new Set<string>();

    // An injection delivered before a turn Codex never accepted: its items are in the thread, the prompt is not.
    if (handoff?.state === "delivered") {
      for (const id of [...handoff.itemIds, ...handoff.omittedItemIds ?? []]) {
        uncovered.delete(id);
        covered.add(id);
      }
    }
    if (!unaccepted) {
      const rows = this.database.prepare(`SELECT id FROM messages WHERE conversation_id = ? AND turn_id = ?
        AND role IN ('user','assistant') ORDER BY created_at, rowid`)
        .all(threadId, run.turnId) as { id: string }[];
      for (const { id } of rows) {
        if (unread.has(id)) {
          covered.delete(id);
          pendingUnread.add(id);
        } else {
          uncovered.delete(id);
          covered.add(id);
        }
      }
    }

    // Step 1: Convert legacy list-only backings and advance coveredThroughOrdinal over consecutive V2 turns.
    let watermark = backing.coveredThroughOrdinal ?? 0;
    const v2Runs = this.database.prepare(`SELECT json_extract(r.payload_json, '$.ordinal') AS ordinal,
        json_extract(r.payload_json, '$.id') AS run_id,
        json_extract(r.payload_json, '$.turnId') AS turn_id,
        EXISTS (SELECT 1 FROM orchestration_v2_entities AS rb
          WHERE rb.kind = 'rolled-back-turn' AND rb.thread_id = r.thread_id
            AND rb.id = json_extract(r.payload_json, '$.turnId')) AS rolled_back
      FROM orchestration_v2_entities AS r
      WHERE r.kind = 'run' AND r.thread_id = ?
        AND json_extract(r.payload_json, '$.ordinal') > ?
      ORDER BY json_extract(r.payload_json, '$.ordinal') ASC`)
      .all(threadId, watermark) as { ordinal: number; run_id: string; turn_id: string; rolled_back: number }[];
    const turnMessagesStmt = this.database.prepare(`SELECT id FROM messages
      WHERE conversation_id = ? AND turn_id = ? AND role IN ('user','assistant')`);
    for (const v2 of v2Runs) {
      if (v2.ordinal !== watermark + 1) break;
      if (v2.rolled_back === 1) {
        for (const { id } of turnMessagesStmt.all(threadId, v2.turn_id) as { id: string }[]) {
          covered.delete(id);
          uncovered.delete(id);
          pendingUnread.delete(id);
        }
        this.dropTurnAttachedIds(threadId, v2.turn_id, v2.run_id, covered, uncovered);
        watermark = v2.ordinal;
        continue;
      }
      const messages = turnMessagesStmt.all(threadId, v2.turn_id) as { id: string }[];
      const allCoveredOrExcepted = messages.every(({ id }) => covered.has(id) || uncovered.has(id) || pendingUnread.has(id));
      if (!allCoveredOrExcepted) break;
      watermark = v2.ordinal;
      for (const { id } of messages) {
        covered.delete(id);
        if (pendingUnread.has(id)) {
          uncovered.add(id);
          pendingUnread.delete(id);
        }
      }
      this.dropTurnAttachedIds(threadId, v2.turn_id, v2.run_id, covered, uncovered);
    }

    // Step 2: Flip legacyCovered when non-V2 turns / turnless messages exist and are all covered or excepted.
    let legacyCovered = backing.legacyCovered === true;
    if (!legacyCovered) {
      const legacyMessages = this.database.prepare(`SELECT m.id, m.turn_id FROM messages AS m
        WHERE m.conversation_id = ? AND m.role IN ('user','assistant')
          AND (m.turn_id IS NULL OR (
            m.turn_id NOT IN (SELECT id FROM orchestration_v2_entities WHERE kind = 'rolled-back-turn' AND thread_id = m.conversation_id)
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_entities AS r
              WHERE r.kind = 'run' AND r.thread_id = m.conversation_id
                AND json_extract(r.payload_json, '$.turnId') = m.turn_id
                AND json_extract(r.payload_json, '$.ordinal') IS NOT NULL)))`)
        .all(threadId) as { id: string; turn_id: string | null }[];
      if (legacyMessages.length > 0 && legacyMessages.every(({ id }) => covered.has(id) || uncovered.has(id))) {
        legacyCovered = true;
        const legacyTurnIds = new Set<string>();
        for (const { id, turn_id: turnId } of legacyMessages) {
          covered.delete(id);
          if (turnId) legacyTurnIds.add(turnId);
        }
        for (const turnId of legacyTurnIds) {
          this.dropTurnAttachedIds(threadId, turnId, null, covered, uncovered);
        }
      }
    }

    // Step 3: Advance inheritedCoverage over fork-history items and flip to "complete" when all are covered.
    let inheritedCoverage: InheritedCoverage | undefined = backing.inheritedCoverage;
    if (inheritedCoverage !== "complete") {
      const forkItems = this.database.prepare(`SELECT id, json_extract(payload_json, '$.ordinal') AS ordinal
        FROM orchestration_v2_entities
        WHERE kind = 'fork-history' AND thread_id = ? AND json_extract(payload_json, '$.part') = 0
          AND json_extract(payload_json, '$.kind') IN ('user-message','assistant-message','command','file','plan','error')
        ORDER BY json_extract(payload_json, '$.ordinal') ASC`)
        .all(threadId) as { id: string; ordinal: number }[];
      if (forkItems.length > 0) {
        const coveredThrough = inheritedCoverage && inheritedCoverage.forkId === threadId
          ? inheritedCoverage.throughOrdinal : -1;
        const isForkItemCovered = (item: { id: string; ordinal: number }) =>
          item.ordinal <= coveredThrough || covered.has(item.id);
        if (forkItems.every(isForkItemCovered)) {
          inheritedCoverage = "complete";
          for (const { id } of forkItems) {
            covered.delete(id);
            uncovered.delete(id);
          }
        } else {
          let nextThrough = coveredThrough;
          for (const item of forkItems) {
            if (item.ordinal <= nextThrough) continue;
            if (item.ordinal !== nextThrough + 1 || !covered.has(item.id)) break;
            nextThrough = item.ordinal;
            covered.delete(item.id);
          }
          if (nextThrough > coveredThrough) {
            inheritedCoverage = { forkId: threadId, throughOrdinal: nextThrough };
          }
        }
      }
    }

    // Drop any IDs still in `covered` that are already covered by watermark, legacyCovered, or inheritedCoverage.
    if (covered.size > 0) {
      this.pruneRedundantCoveredIds(threadId, covered, watermark, legacyCovered, inheritedCoverage);
    }

    // Keep covered and uncovered disjoint.
    for (const id of covered) uncovered.delete(id);

    const coveredList = [...covered];
    const uncoveredList = [...uncovered];
    const coverageComplete = backing.coverageComplete
      && coveredList.length <= MAX_BACKING_COVERAGE_ITEMS
      && uncoveredList.length <= MAX_BACKING_UNCOVERED_ITEMS;
    const includeWatermark = watermark > 0 || backing.coveredThroughOrdinal !== undefined;
    return {
      coveredItemIds: coveredList.slice(-MAX_BACKING_COVERAGE_ITEMS),
      coverageComplete,
      ...optionalCoverageFields({
        ...(includeWatermark ? { coveredThroughOrdinal: watermark } : {}),
        ...(uncoveredList.length > 0 ? { uncoveredItemIds: uncoveredList.slice(-MAX_BACKING_UNCOVERED_ITEMS) } : {}),
        ...(inheritedCoverage !== undefined ? { inheritedCoverage } : {}),
        ...(legacyCovered ? { legacyCovered: true } : {}),
      }),
    };
  }

  private pruneRedundantCoveredIds(
    threadId: string,
    covered: Set<string>,
    watermark: number,
    legacyCovered: boolean,
    inheritedCoverage: InheritedCoverage | undefined,
  ): void {
    const candidatesJson = JSON.stringify([...covered]);
    if (watermark > 0) {
      const msgRows = this.database.prepare(`SELECT m.id FROM messages AS m
        JOIN agent_turns AS t ON t.id = m.turn_id AND t.conversation_id = m.conversation_id
        JOIN orchestration_v2_entities AS r ON r.kind = 'run' AND r.thread_id = m.conversation_id AND r.id = t.run_id
        WHERE m.conversation_id = ? AND m.id IN (SELECT value FROM json_each(?))
          AND json_extract(r.payload_json, '$.ordinal') <= ?`)
        .all(threadId, candidatesJson, watermark) as { id: string }[];
      for (const { id } of msgRows) covered.delete(id);
    }
    if (legacyCovered && covered.size > 0) {
      const legacyRows = this.database.prepare(`SELECT m.id FROM messages AS m
        WHERE m.conversation_id = ? AND m.id IN (SELECT value FROM json_each(?))
          AND (m.turn_id IS NULL OR NOT EXISTS (SELECT 1 FROM agent_turns AS t
            JOIN orchestration_v2_entities AS r ON r.kind = 'run' AND r.thread_id = m.conversation_id AND r.id = t.run_id
            WHERE t.id = m.turn_id AND t.conversation_id = m.conversation_id
              AND json_extract(r.payload_json, '$.ordinal') IS NOT NULL))`)
        .all(threadId, JSON.stringify([...covered])) as { id: string }[];
      for (const { id } of legacyRows) covered.delete(id);
    }
    if (inheritedCoverage !== undefined && covered.size > 0) {
      const forkRows = inheritedCoverage === "complete"
        ? this.database.prepare(`SELECT id FROM orchestration_v2_entities
            WHERE kind = 'fork-history' AND thread_id = ? AND json_extract(payload_json, '$.part') = 0
              AND id IN (SELECT value FROM json_each(?))`)
            .all(threadId, JSON.stringify([...covered])) as { id: string }[]
        : inheritedCoverage.forkId === threadId
          ? this.database.prepare(`SELECT id FROM orchestration_v2_entities
              WHERE kind = 'fork-history' AND thread_id = ? AND json_extract(payload_json, '$.part') = 0
                AND json_extract(payload_json, '$.ordinal') <= ?
                AND id IN (SELECT value FROM json_each(?))`)
              .all(threadId, inheritedCoverage.throughOrdinal, JSON.stringify([...covered])) as { id: string }[]
          : [];
      for (const { id } of forkRows) covered.delete(id);
    }
    if ((watermark > 0 || legacyCovered) && covered.size > 0) {
      for (const id of covered) {
        if (!id.startsWith("activity:") && !id.startsWith("plan:") && !id.startsWith("files:") && !id.startsWith("interrupt:")) continue;
        let turnId: string | null | undefined;
        if (id.startsWith("activity:")) {
          turnId = (this.database.prepare("SELECT turn_id FROM activities WHERE id = ? AND conversation_id = ?")
            .get(id.slice("activity:".length), threadId) as { turn_id: string | null } | undefined)?.turn_id;
        } else if (id.startsWith("plan:")) {
          turnId = (this.database.prepare("SELECT turn_id FROM agent_plans WHERE run_id = ? AND conversation_id = ?")
            .get(id.slice("plan:".length), threadId) as { turn_id: string | null } | undefined)?.turn_id;
        } else if (id.startsWith("files:")) {
          turnId = (this.database.prepare("SELECT turn_id FROM turn_git_artifacts WHERE id = ? AND conversation_id = ?")
            .get(id.slice("files:".length), threadId) as { turn_id: string | null } | undefined)?.turn_id;
        } else {
          turnId = id.slice("interrupt:".length);
        }
        if (!turnId) continue;
        const row = this.database.prepare(`SELECT json_extract(r.payload_json, '$.ordinal') AS ordinal
          FROM agent_turns AS t
          LEFT JOIN orchestration_v2_entities AS r ON r.kind = 'run' AND r.thread_id = t.conversation_id AND r.id = t.run_id
          WHERE t.id = ? AND t.conversation_id = ? LIMIT 1`)
          .get(turnId, threadId) as { ordinal: number | null } | undefined;
        if (!row) continue;
        if ((typeof row.ordinal === "number" && row.ordinal <= watermark) || (row.ordinal === null && legacyCovered)) {
          covered.delete(id);
        }
      }
    }
  }

  private dropTurnAttachedIds(
    threadId: string,
    turnId: string,
    runId: string | null,
    covered: Set<string>,
    uncovered: Set<string>,
  ): void {
    if (covered.size === 0) return;
    covered.delete(`interrupt:${turnId}`);
    if (runId && !uncovered.has(`plan:${runId}`)) covered.delete(`plan:${runId}`);
    for (const id of covered) {
      if (!id.startsWith("activity:") && !id.startsWith("plan:") && !id.startsWith("files:")) continue;
      if (id.startsWith("activity:")) {
        const key = id.slice("activity:".length);
        const match = this.database.prepare("SELECT 1 FROM activities WHERE id = ? AND conversation_id = ? AND turn_id = ? LIMIT 1")
          .get(key, threadId, turnId);
        if (match) covered.delete(id);
      } else if (id.startsWith("plan:")) {
        const key = id.slice("plan:".length);
        const match = this.database.prepare("SELECT 1 FROM agent_plans WHERE run_id = ? AND conversation_id = ? AND turn_id = ? LIMIT 1")
          .get(key, threadId, turnId);
        if (match) covered.delete(id);
      } else if (id.startsWith("files:")) {
        const key = id.slice("files:".length);
        const match = this.database.prepare("SELECT 1 FROM turn_git_artifacts WHERE id = ? AND conversation_id = ? AND turn_id = ? LIMIT 1")
          .get(key, threadId, turnId);
        if (match) covered.delete(id);
      }
    }
  }

  /**
   * Evidence that the provider accepted the run's turn, on a harness that
   * reports acceptance: completion, a native turn boundary on its attempt (the
   * `turn/start` response or `turn/started`), an inline handoff its output
   * delivered, or an assistant message. Activity is not evidence: Codex
   * records configuration, deprecation, MCP startup and thread notices as
   * status activities while it opens the thread, before any turn exists, and
   * every turn-scoped item (command, tool, file change, reasoning) follows the
   * boundary that already counts.
   */
  private turnAccepted(turn: AgentTurn, run: OrchestrationRun, handoff: ContextHandoff | null): boolean {
    if (turn.status === "completed" || this.events.projection("native-boundary", run.attemptId)
      || (handoff?.state === "delivered" && handoff.method === "inline")) return true;
    return this.database.prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND turn_id = ?
      AND role = 'assistant' LIMIT 1`).get(run.threadId, run.turnId) !== undefined;
  }

  /**
   * Dispatch moved the backing to this run (and to `uncertain` for a prepared
   * handoff) and kept its earlier value in that record. Restore that value, so
   * the next turn sees the backing it would have seen without this run. Unlike
   * a record, a restore touches no attempt.
   */
  private restoreBeforeRun(backing: ProviderBacking, runId: string, retireIfFresh = false): void {
    const row = this.database.prepare(`SELECT payload_json FROM orchestration_v2_events
      WHERE thread_id = ? AND type = 'provider.backing-recorded' AND json_extract(payload_json, '$.runId') = ?
        AND json_extract(payload_json, '$.backing.id') = ? AND json_extract(payload_json, '$.beforeDispatch') IS NOT NULL
      ORDER BY revision DESC LIMIT 1`).get(backing.threadId, runId, backing.id) as { payload_json: string } | undefined;
    if (!row) {
      // A brand-new backing created during an explicitly undelivered/dropped/uncertain run has no prior state to restore: retire it so it is never resumed.
      if (retireIfFresh) this.invalidate(backing, "uncertain-delivery");
      return;
    }
    const before = providerBackingSchema.parse((JSON.parse(row.payload_json) as { beforeDispatch: unknown }).beforeDispatch);
    if (before.status === "retired" || before.lastRunId === runId) {
      this.invalidate(backing, "uncertain-delivery");
      return;
    }
    // A backing that moved to a copy of its session during the run (`forkSession`) keeps the copy: it holds the
    // same history the backing held before dispatch.
    const {
      coveredThroughOrdinal: _c,
      uncoveredItemIds: _u,
      inheritedCoverage: _i,
      legacyCovered: _l,
      ...beforeBase
    } = before;
    this.commit(backing.threadId, backing.projectId, { type: "provider.backing-restored", payload: { runId,
      backing: providerBackingSchema.parse({ ...beforeBase, nativeSessionId: backing.nativeSessionId,
        coveredItemIds: backing.coveredItemIds, coverageComplete: backing.coverageComplete,
        ...optionalCoverageFields(backing), updatedAt: new Date().toISOString() }) } });
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

  /** The backing of the native session the run's current attempt works on, in the run's checkout. */
  private attemptBacking(run: OrchestrationRun): ProviderBacking | null {
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    return attempt.nativeSessionId ? this.find({ threadId: run.threadId, providerId: run.providerId,
      workspaceKey: run.workspaceKey, identity: this.turnIdentity(run.turnId), nativeSessionId: attempt.nativeSessionId }) : null;
  }

  private record(backing: ProviderBacking, runId: string, attemptId: string, beforeDispatch?: ProviderBacking): void {
    const previous = this.get(backing.id);
    if (previous && durableJson({ ...backing, updatedAt: previous.updatedAt }) === durableJson(previous)) return;
    const value = providerBackingSchema.parse({ ...backing, updatedAt: new Date().toISOString() });
    this.commit(backing.threadId, backing.projectId, { type: "provider.backing-recorded",
      payload: { backing: value, runId, attemptId, ...(beforeDispatch ? { beforeDispatch } : {}) } });
  }

  private changeHandoff(handoff: ContextHandoff, state: "dispatching" | "delivered" | "uncertain" | "abandoned",
    backing?: ProviderBacking | null, method?: ContextHandoff["method"]): void {
    const run = this.run(handoff.runId)!;
    this.commit(handoff.threadId, run.projectId, { type: "context.handoff-state-changed", payload: {
      handoffId: handoff.id, runId: handoff.runId, attemptId: handoff.attemptId, state,
      targetBackingId: backing?.id ?? handoff.targetBackingId, nativeSessionId: backing?.nativeSessionId ?? handoff.nativeSessionId,
      // Written only when native delivery is involved, so inline handoffs keep the event shape older logs replay.
      ...(method ? { method } : {}),
    } });
  }

  private commit(threadId: string, projectId: string, event: OrchestrationBackingEvent): void {
    this.events.commit({ actorId: "runtime", commandId: `backing:${commandFingerprint(event)}`,
      threadId, projectId, command: event, expectedRevision: this.events.revision(threadId), events: [event], result: null });
  }

}
