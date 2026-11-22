import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import type { AgentTurn, ChatMessage, Conversation } from "../../shared/contracts";
import { modelSelectionSchema } from "../../shared/model-routing";
import { TURN_GIT_ARTIFACT_FINALIZATION_TIMEOUT_MS } from "../../shared/runtime-command-timeouts";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import {
  orchestrationAttemptSchema,
  orchestrationCleanupReleaseSchema,
  orchestrationRunSchema,
  orchestrationThreadSchema,
  type OrchestrationAttempt,
  type OrchestrationAttemptReplacementReason,
  type OrchestrationCleanupRelease,
  type OrchestrationDomainEvent,
  type OrchestrationRunFailureCode,
} from "../../shared/orchestration-v2";
import type { PreparedContextHandoff } from "../../shared/orchestration-backings";
import type { BeginAgentTurnInput, NewConversationOptions } from "../persistence/types";
import { staleAttemptObservation, type AttemptObserver, type StaleAttemptObservation } from "./attempt-fence";
import { OrchestrationEffectOutbox } from "./effect-outbox";
import { CHECKPOINT_CAPTURE_EFFECT_KIND, checkpointCaptureEffect, type OrchestrationEffectRuntime } from "./effect-runtime";
import { OrchestrationEventStore } from "./event-store";
import { commandFingerprint, durableJson } from "./json";
import { ORCHESTRATION_V2_PROJECTION_VERSION, projectOrchestrationEvent } from "./projector";
import { portableHistoryItem, readPortableContinuationHistory } from "./portable-history-source";
import { missedRunImageAttachments } from "./missed-run-attachments";
import { ProviderBackingRepository } from "./backing-repository";
import { NativeBoundaryRepository } from "./native-boundary-repository";
import { NativeControlRepository } from "./native-control-repository";
import { ForkRepository } from "./fork-repository";
import { HistoryRollbackRepository } from "./history-rollback-repository";
import { MergeBackRepository, type MergeBackAccess } from "./merge-back-repository";
import { DelegationRepository } from "./delegation-repository";
import { OrchestrationCommandLanes } from "./command-lanes";
import { OrchestrationCommandAuthority } from "./command-authority";
import { RunControlRepository } from "./run-control-repository";
import { providerInstanceId } from "./provider-instance";
import { dropRestoredHistoryRecord } from "../persistence/turn-restored-history-record";
import {
  OrchestrationConflict,
  OrchestrationProjectionVerificationError,
  OrchestrationStateUnreadable,
  type CommandSource,
  type JsonValue,
  type OrchestrationEffect,
  type ProjectionMaintenance,
} from "./types";

interface TurnProjectionAccess extends MergeBackAccess {
  conversation(id: string): Conversation;
  conversationPath(id: string): string;
  agentTurn(id: string): AgentTurn;
  message(id: string): ChatMessage;
  createConversation(projectId: string, title: string, options: NewConversationOptions): Conversation;
}

export interface AttemptReplacement {
  runId: string;
  turnId: string;
  expectedAttemptId: string;
  reason: OrchestrationAttemptReplacementReason;
  priorCleanup?: "confirmed";
}

function readableProjection(kind: string, value: JsonValue): boolean {
  if (kind === "thread") return orchestrationThreadSchema.safeParse(value).success;
  if (kind === "run") return orchestrationRunSchema.safeParse(value).success;
  return kind !== "attempt" || orchestrationAttemptSchema.safeParse(value).success;
}

/** Bridges existing transcript/execution projections into the V2 transaction. */
export class OrchestratedTurnRepository {
  readonly events: OrchestrationEventStore;
  readonly effects: OrchestrationEffectOutbox;
  readonly backings: ProviderBackingRepository;
  readonly nativeBoundaries: NativeBoundaryRepository;
  readonly nativeControls: NativeControlRepository;
  readonly forks: ForkRepository;
  readonly history: HistoryRollbackRepository;
  readonly mergeBacks: MergeBackRepository;
  readonly delegation: DelegationRepository;
  readonly lanes = new OrchestrationCommandLanes();
  readonly authority: OrchestrationCommandAuthority;
  readonly runControl: RunControlRepository;
  #effectRuntime: OrchestrationEffectRuntime | null = null;

  constructor(
    private readonly database: Database.Database,
    private readonly access: TurnProjectionAccess,
    readonly runtimeId: string = randomUUID(),
    systemBootId: string | null = null,
    projectionVersion: number = ORCHESTRATION_V2_PROJECTION_VERSION,
  ) {
    this.effects = new OrchestrationEffectOutbox(database, runtimeId);
    this.events = new OrchestrationEventStore(database, projectOrchestrationEvent, runtimeId, undefined,
      () => this.effects.notifyAvailable(), projectionVersion, readableProjection);
    this.backings = new ProviderBackingRepository(database, this.events);
    this.nativeBoundaries = new NativeBoundaryRepository(database, this.events);
    this.history = new HistoryRollbackRepository(database, this.events);
    this.nativeControls = new NativeControlRepository(database, this.events, this.effects, this.history, runtimeId, systemBootId);
    this.forks = new ForkRepository(database, this.events, this.nativeBoundaries, this.history, access);
    this.mergeBacks = new MergeBackRepository(database, this.events, this.forks, this.history, access);
    this.delegation = new DelegationRepository(database, this.events, access);
    this.authority = new OrchestrationCommandAuthority(this.events, this.lanes);
    this.runControl = new RunControlRepository(this.events, this.effects, (runId) => this.startIntent(runId));
  }

  maintainProjections(): ProjectionMaintenance {
    const checked = this.events.verify();
    if (checked.valid) return { ...checked, rebuilt: false, beforeRebuild: null };
    const beforeRebuild = this.events.verify({ readable: true });
    this.delegation.rebuildProjections();
    const repaired = this.events.verify({ readable: true });
    if (!repaired.valid) throw new OrchestrationProjectionVerificationError(repaired);
    return { ...repaired, rebuilt: true, beforeRebuild };
  }

  admit(
    input: BeginAgentTurnInput,
    createCompatibilityTurn: () => { message: ChatMessage; turn: AgentTurn },
    source?: CommandSource,
  ): { message: ChatMessage; turn: AgentTurn } {
    return this.database.transaction(() => {
      const conversation = this.access.conversation(input.conversationId);
      const identity = { actorId: source?.actorId ?? "runtime", commandId: source?.commandId ?? input.id ?? input.runId,
        projectId: conversation.projectId, threadId: conversation.id };
      // Preparation creates incidental identities. They are not part of caller intent.
      const { id: _turnId, runId: _runId, requestedAt: _requestedAt, nativeContinuation, backingRelocation,
        preparedWorkspaceKey, ...intent } = input;
      const command = source?.command ?? JSON.parse(JSON.stringify({ type: "run.start", ...intent })) as JsonValue;
      const previous = this.events.receipt(identity, command);
      if (previous) {
        const result = previous.result as { turnId: string; messageId: string };
        return { turn: this.access.agentTurn(result.turnId), message: this.access.message(result.messageId) };
      }
      if (this.hasPendingCleanup(conversation.id)) throw new OrchestrationConflict("cleanup-pending");
      // Preparation chose the session, its relocation and its handoff for one checkout.
      if (preparedWorkspaceKey !== undefined && preparedWorkspaceKey !== this.access.conversationPath(conversation.id)) {
        throw new OrchestrationConflict("checkout-changed");
      }
      if (this.forks.get(conversation.id)?.transfer === "pending") {
        this.nativeControls.selectPortable(conversation.id, conversation.projectId, "portable-first-send");
      }
      const relocatedFrom = backingRelocation ? this.backings.get(backingRelocation.fromBackingId) : null;
      if (backingRelocation) {
        // Preparation chose to resume another checkout's session here; the event below re-checks it.
        if (!relocatedFrom || relocatedFrom.status !== "ready" || !input.providerSessionBefore || !input.continuationIdentity
          || relocatedFrom.nativeSessionId !== input.providerSessionBefore) throw new OrchestrationConflict("revision-conflict");
        this.database.prepare("UPDATE conversations SET provider_session_id = ?, continuation_identity_json = ? WHERE id = ?")
          .run(relocatedFrom.nativeSessionId, JSON.stringify(input.continuationIdentity), conversation.id);
      } else if (input.providerSessionBefore && input.continuationIdentity) {
        const backing = this.backings.find({ threadId: conversation.id, providerId: input.providerId,
          workspaceKey: this.access.conversationPath(conversation.id), identity: input.continuationIdentity,
          nativeSessionId: input.providerSessionBefore });
        if (backing) {
          if (backing.status !== "ready") throw new OrchestrationConflict("revision-conflict");
          this.database.prepare("UPDATE conversations SET provider_session_id = ?, continuation_identity_json = ? WHERE id = ?")
            .run(backing.nativeSessionId, JSON.stringify(input.continuationIdentity), conversation.id);
        }
      }
      const queued = createCompatibilityTurn();
      const { turn } = queued;
      const selection = modelSelectionSchema.parse(turn.modelSelection);
      const workspaceKey = this.access.conversationPath(conversation.id);
      const instanceId = providerInstanceId(turn.providerId, turn.continuationIdentity);
      const attemptId = randomUUID();
      const events: OrchestrationDomainEvent[] = [];
      if (!this.events.projection("thread", conversation.id)) {
        events.push({ type: "thread.registered", payload: {
          id: conversation.id, projectId: conversation.projectId, workspaceKey,
          title: conversation.title, providerId: turn.providerId, selection,
          activeRunId: null, latestRunId: null, createdAt: conversation.createdAt, updatedAt: turn.requestedAt,
        } });
      } else {
        events.push({ type: "thread.configured", payload: { providerId: turn.providerId,
          selection, workspaceKey, title: conversation.title } });
      }
      events.push({ type: "run.accepted", payload: {
        run: { id: turn.runId, threadId: conversation.id, projectId: conversation.projectId,
          turnId: turn.id, messageId: queued.message.id, attemptId, providerInstanceId: instanceId,
          providerId: turn.providerId, selection, workspaceKey,
          status: "queued", executionState: "queued", providerState: null,
          stateRevision: 0, requestedAt: turn.requestedAt,
          startedAt: null, completedAt: null, terminalMessageId: null },
        attempt: { id: attemptId, runId: turn.runId, turnId: turn.id, threadId: conversation.id,
          providerInstanceId: instanceId, status: "queued", nativeSessionId: turn.providerSessionBefore,
          nativeThreadId: null, nativeTurnId: null, interruptRequestedAt: null,
          cleanup: "not-started", runtimeId: this.runtimeId },
      } });
      if (relocatedFrom) events.push(this.backings.relocation({ id: turn.runId, attemptId, threadId: conversation.id,
        providerInstanceId: instanceId, workspaceKey }, relocatedFrom.id, turn.providerSessionBefore));
      if (input.contextHandoff) events.push(this.backings.preparation(turn.runId, attemptId,
        conversation.id, turn.requestedAt, input.contextHandoff, relocatedFrom ?? undefined));
      this.events.commit({ ...identity, command,
        expectedRevision: this.events.revision(conversation.id), events,
        effects: [{ id: this.startEffectId(turn.runId), eventIndex: events.length - 1,
          kind: "provider.start", replayPolicy: "process-bound",
          payload: { runId: turn.runId, turnId: turn.id, attemptId } }],
        result: { turnId: turn.id, runId: turn.runId, messageId: queued.message.id, attemptId },
      });
      if (nativeContinuation) {
        const pending = turn.providerSessionBefore ? this.history.continuationFor({ threadId: conversation.id,
          providerInstanceId: instanceId, workspaceKey, nativeSessionId: turn.providerSessionBefore }) : null;
        if (pending?.rollbackId !== nativeContinuation.rollbackId
          || durableJson(pending.continuation) !== durableJson(nativeContinuation.continuation)) {
          throw new OrchestrationConflict("revision-conflict");
        }
        this.history.attach(conversation.id, conversation.projectId, pending.rollbackId, turn.runId);
      }
      this.mergeBacks.attach(conversation.id, input.conversationContextPacketIds ?? [], turn.runId, queued.message.id);
      if (input.delegatedCompletion) this.delegation.attachWake(conversation.id, turn.id);
      const resumedTurnId = input.limitResetPlanId
        ? (this.database.prepare("SELECT failed_turn_id AS id FROM usage_limit_resume_plans WHERE id = ?")
          .get(input.limitResetPlanId) as { id: string } | undefined)?.id
        : input.restartContinuationPlanId
          ? (this.database.prepare("SELECT interrupted_turn_id AS id FROM restart_continuation_plans WHERE id = ?")
            .get(input.restartContinuationPlanId) as { id: string } | undefined)?.id
          : undefined;
      if (resumedTurnId) this.delegation.attachContinuation(conversation.id, resumedTurnId, turn.id);
      return queued;
    }).immediate();
  }

  acceptedRequest(conversationId: string, source: CommandSource): { turn: AgentTurn; message: ChatMessage } | null {
    const conversation = this.access.conversation(conversationId);
    const receipt = this.events.receipt({ ...source, threadId: conversation.id, projectId: conversation.projectId }, source.command);
    if (!receipt) return null;
    const result = receipt.result as { turnId: string; messageId: string };
    const turn = this.access.agentTurn(result.turnId);
    if (turn.conversationId !== conversationId || turn.userMessageId !== result.messageId) {
      throw new Error("The orchestration receipt does not match its transcript projection.");
    }
    return { turn, message: this.access.message(result.messageId) };
  }

  /** The run's current attempt, or null for a run V2 never admitted. */
  currentAttemptId(runId: string): string | null {
    const row = this.events.projection("run", runId);
    return row ? orchestrationRunSchema.parse(row.value).attemptId : null;
  }

  /** Whether an observation from `observer`'s attempt may still write; writes nothing itself. */
  observation(runId: string, observer: AttemptObserver): StaleAttemptObservation | null {
    const row = this.events.projection("run", runId);
    return row ? staleAttemptObservation(this.events, orchestrationRunSchema.parse(row.value), observer) : null;
  }

  /**
   * In-run fresh-session fallback after the provider rejected a native resume:
   * the compatibility restart and a `provider_recovery` replacement of the
   * expected attempt commit together, so the rejected attempt is superseded
   * and its late observations write nothing. Returns the replacement attempt,
   * or null for a run V2 never admitted.
   */
  restartOnFreshSession<T>(input: { turn: AgentTurn; expectedSessionId: string; expectedAttemptId: string | null;
    prepared: PreparedContextHandoff | undefined; priorCleanup: "confirmed" }, restart: () => T):
    { result: T; attemptId: string | null } {
    let attemptId: string | null = null;
    const result = this.backings.restart(input.turn, input.expectedSessionId, input.prepared, restart, (run) => {
      // A caller that does not know which attempt it ran cannot replace one.
      if (input.expectedAttemptId === null) throw new OrchestrationConflict("revision-conflict");
      // A Stop recorded its interrupt and claimed its effect on this attempt; recovery would strand them. Refused
      // here, not in the projector, so logs written before this check still rebuild.
      const expected = this.events.projection("attempt", input.expectedAttemptId);
      if (expected && orchestrationAttemptSchema.parse(expected.value).interruptRequestedAt !== null) {
        throw new OrchestrationConflict("revision-conflict");
      }
      attemptId = this.replaceAttempt({ runId: run.id, turnId: run.turnId, expectedAttemptId: input.expectedAttemptId,
        reason: "provider_recovery", priorCleanup: input.priorCleanup }).id;
      return attemptId;
    });
    return { result, attemptId };
  }

  acknowledge(runId: string, observer?: AttemptObserver): StaleAttemptObservation | null {
    const row = observer ? this.events.projection("run", runId) : null;
    const stale = row ? staleAttemptObservation(this.events, orchestrationRunSchema.parse(row.value), observer) : null;
    if (stale) return stale;
    this.backings.acknowledge(runId);
    this.history.acknowledge(runId);
    this.mergeBacks.acknowledge(runId);
    return null;
  }

  /** One step of native history delivery, for the run's current attempt only; false writes nothing. */
  historyInjection(runId: string, attemptId: string, step: "begin" | "delivered" | "unsupported"): boolean {
    return this.backings.historyInjection(runId, attemptId, step);
  }

  attempts(runId: string): OrchestrationAttempt[] {
    const row = this.events.projection("run", runId);
    if (!row) return [];
    return (this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE thread_id = ? AND kind = 'attempt' AND json_extract(payload_json, '$.runId') = ?
      ORDER BY json_extract(payload_json, '$.ordinal'), id`).all(row.threadId, runId) as { payload_json: string }[])
      .map(({ payload_json }) => orchestrationAttemptSchema.parse(JSON.parse(payload_json)));
  }

  hasPendingCleanup(threadId: string): boolean {
    return this.attemptCleanupIn(threadId, ["pending", "unconfirmed"]);
  }

  awaitsCleanupProof(threadId: string): boolean {
    return this.attemptCleanupIn(threadId, ["pending", "unconfirmed", "unconfirmed-released"]);
  }

  private attemptCleanupIn(threadId: string, states: readonly string[]): boolean {
    if (this.nativeControls.locked(threadId)) return true;
    return this.database.prepare(`SELECT 1 FROM orchestration_v2_entities
      WHERE thread_id = ? AND kind = 'attempt'
        AND json_extract(payload_json, '$.cleanup') IN (${states.map(() => "?").join(",")}) LIMIT 1`)
      .get(threadId, ...states) !== undefined;
  }

  portableHistory(input: Parameters<typeof readPortableContinuationHistory>[1]) {
    this.access.conversation(input.threadId);
    return readPortableContinuationHistory(this.database, input);
  }

  /** Images of this chat's runs its provider instance never received, still due on the next prompt. */
  missedRunImages(input: Parameters<typeof missedRunImageAttachments>[1]) {
    this.access.conversation(input.threadId);
    return missedRunImageAttachments(this.database, input);
  }

  /** One item of this chat's own portable history by its handoff id; never another chat's. */
  portableHistoryItem(input: Parameters<typeof portableHistoryItem>[1]) {
    this.access.conversation(input.threadId);
    return portableHistoryItem(this.database, input);
  }

  /**
   * The native session whose encrypted history Codex rejected (T3 `rejected_native_history`, b99333dc7): the
   * session of the chat's latest run on `providerInstanceId` that its provider accepted, when that run failed
   * with `invalid_encrypted_content`. A run its provider never received (`delivery` set) is passed over, as T3
   * passes over runs without a delivered provider turn; a dropped prompt (`promptDropped`) always sets `delivery`.
   * Null otherwise, and for a run without a native session.
   */
  rejectedNativeHistorySession(threadId: string, instanceId: string): string | null {
    const row = this.database.prepare(`SELECT run.payload_json AS run_json FROM agent_turns AS turn
      JOIN orchestration_v2_entities AS run ON run.kind = 'run' AND run.id = turn.run_id
      WHERE turn.conversation_id = ? AND json_extract(run.payload_json, '$.providerInstanceId') = ?
        AND json_extract(run.payload_json, '$.delivery') IS NULL
      ORDER BY turn.requested_at DESC, turn.rowid DESC LIMIT 1`).get(threadId, instanceId) as
      { run_json: string } | undefined;
    if (!row) return null;
    // A rolled-back run still counts: a native revert keeps the session and the older turns whose content was rejected.
    const run = orchestrationRunSchema.parse(JSON.parse(row.run_json));
    if (run.status !== "failed" || run.failureCode !== "invalid_encrypted_content") return null;
    const attempt = this.events.projection("attempt", run.attemptId);
    return attempt ? orchestrationAttemptSchema.parse(attempt.value).nativeSessionId : null;
  }

  /**
   * `unreadFollowUpMessageIds` is read after `updateCompatibilityProjection` runs, which may fill it.
   * `afterSynchronize` runs in the same transaction once the run's projection has decided what it records.
   */
  lifecycle<T>(turnId: string, updateCompatibilityProjection: () => T, delivery?: "not-delivered" | "prompt-dropped",
    failureCode?: OrchestrationRunFailureCode, unreadFollowUpMessageIds?: readonly string[], providerStopReason?: string,
    afterSynchronize?: (result: T) => void): T {
    return this.database.transaction(() => {
      const result = updateCompatibilityProjection();
      this.synchronize(this.access.agentTurn(turnId), undefined, delivery, failureCode, unreadFollowUpMessageIds,
        providerStopReason);
      // Last, after everything the run records: a failure it swallows leaves nothing of the settlement unwritten.
      afterSynchronize?.(result);
      return result;
    }).immediate();
  }

  /** The provider stop reason the turn's V2 run recorded; undefined for none, or for a turn without a V2 run. */
  recordedProviderStopReason(turnId: string): string | undefined {
    const row = this.events.projection("run", this.access.agentTurn(turnId).runId);
    return row ? orchestrationRunSchema.parse(row.value).providerStopReason : undefined;
  }

  lifecycleIfCurrent<T>(turnId: string, observer: AttemptObserver, updateCompatibilityProjection: () => T):
    { committed: true; result: T } | { committed: false; stale: StaleAttemptObservation } {
    return this.database.transaction(() => {
      const row = this.events.projection("run", this.access.agentTurn(turnId).runId);
      const stale = row ? staleAttemptObservation(this.events, orchestrationRunSchema.parse(row.value), observer) : null;
      if (stale) return { committed: false as const, stale };
      const result = updateCompatibilityProjection();
      this.synchronize(this.access.agentTurn(turnId));
      return { committed: true as const, result };
    }).immediate();
  }

  admitPair<T>(create: () => [T, T], link: (pair: [T, T]) => void): [T, T] {
    return this.database.transaction(() => {
      const pair = create();
      link(pair);
      return pair;
    })();
  }

  /**
   * `delivery: "not-delivered"` settles a run the provider refused before
   * anything reached it: its handoff is abandoned and its backing and
   * continuation cursors return to their state before dispatch. A run whose
   * history was injected but whose turn was never accepted is recorded as
   * `prompt-not-delivered` and otherwise settles as delivered history.
   * `delivery: "prompt-dropped"` (T3 `promptDropped`) settles a run whose
   * provider dropped its prompt, on any end but completion, as a turn the
   * provider never accepted, whatever output it streamed: its run is
   * `not-delivered` (or `prompt-not-delivered` after an injection) and marked
   * `promptDropped`, its handoff is abandoned even once output delivered it,
   * and its backing returns to its state before dispatch. Only an explicit
   * refusal returns a rollback cursor: the dropped run opened its session.
   * `failureCode` is recorded on a failed run only, and `providerStopReason` (T3 `turn.terminal.reason`) on a
   * terminal run that did not fail.
   */
  synchronize(turn: AgentTurn, observer?: AttemptObserver, delivery?: "not-delivered" | "prompt-dropped",
    failureCode?: OrchestrationRunFailureCode, unreadFollowUpMessageIds: readonly string[] = [],
    providerStopReason?: string): StaleAttemptObservation | null {
    const previous = this.events.projection("run", turn.runId);
    if (!previous) return null; // Imported/pre-V2 history has no invented execution authority.
    const run = orchestrationRunSchema.parse(previous.value);
    const stale = staleAttemptObservation(this.events, run, observer);
    if (stale) return stale;
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    // Decided once: on a harness that reports acceptance, a turn its provider never accepted delivered its prompt
    // to no one. Unless its history was injected, the run did not reach the provider at all; with it injected the
    // route was reached but the prompt (and its images) still was not (`prompt-not-delivered`).
    const explicit = delivery === "not-delivered";
    // A dropped prompt is the provider's own report that it never accepted the turn (T3 `isDeliveredProviderTurn`).
    const dropped = delivery === "prompt-dropped" && isAgentTurnTerminalStatus(turn.status) && turn.status !== "completed";
    const unaccepted = isAgentTurnTerminalStatus(turn.status) && (dropped || this.backings.unaccepted(turn));
    const injected = unaccepted && this.backings.historyInjected(this.backings.handoff(turn.runId));
    const notDelivered = (explicit && turn.status === "failed") || (unaccepted && !injected);
    const event: OrchestrationDomainEvent = { type: "run.status-changed", payload: {
      runId: turn.runId, attemptId: run.attemptId, status: turn.status,
      executionState: turn.runState?.state ?? turn.status,
      providerState: turn.runState?.providerState ?? null,
      stateRevision: turn.runState?.revision ?? run.stateRevision + 1,
      startedAt: turn.startedAt, completedAt: turn.completedAt,
      terminalMessageId: turn.terminalAssistantMessageId,
      nativeSessionId: turn.providerSessionAfter ?? turn.providerSessionBefore,
      ...(notDelivered ? { delivery: "not-delivered" as const }
        : unaccepted && injected ? { delivery: "prompt-not-delivered" as const } : {}),
      ...(dropped ? { promptDropped: true as const } : {}),
      ...(failureCode && turn.status === "failed" ? { failureCode } : {}),
      ...(providerStopReason && isAgentTurnTerminalStatus(turn.status) && turn.status !== "failed"
        ? { providerStopReason } : {}),
    } };
    const before = { ...event.payload, status: run.status, stateRevision: run.stateRevision,
      executionState: run.executionState, providerState: run.providerState,
      startedAt: run.startedAt, completedAt: run.completedAt, terminalMessageId: run.terminalMessageId,
      nativeSessionId: attempt.nativeSessionId };
    if (durableJson(before) === durableJson(event.payload)) return null;
    const capture = isAgentTurnTerminalStatus(turn.status) && !isAgentTurnTerminalStatus(run.status)
      && !this.readOnlyWatcher(turn.conversationId)
      ? checkpointCaptureEffect({ conversationId: turn.conversationId, turnId: turn.id, runId: turn.runId }, 0)
      : null;
    this.events.commit({ actorId: "runtime", commandId: `lifecycle:${commandFingerprint({ turnId: turn.id, ...event.payload })}`,
      projectId: run.projectId, threadId: run.threadId, command: event,
      expectedRevision: this.events.revision(run.threadId), events: [event],
      ...(capture && !this.effects.get(capture.id) ? { effects: [capture] } : {}), result: null });
    if (isAgentTurnTerminalStatus(turn.status)) this.effects.retirePending(this.startEffectId(turn.runId), "run-settled");
    if (unaccepted && !injected && !explicit) dropRestoredHistoryRecord(this.database, turn.id);
    this.backings.settle(turn, explicit, unaccepted, dropped, unreadFollowUpMessageIds);
    // A rollback cursor is a launch option the harness applies when it opens the session, before any turn, so
    // acceptance says nothing about it: only an explicit refusal returns it to pending; otherwise an applied-or-not
    // cursor stays uncertain and its backing continues portably. (Codex, the one harness that reports acceptance,
    // rolls back with `thread/revert` and returns no continuation.) Merge-back packets travel with the prompt, so
    // an unaccepted turn delivered none, even when its history was injected.
    this.history.settleRun(turn, (backing) => this.backings.invalidate(backing, "uncertain-delivery"), explicit);
    this.mergeBacks.settleRun(turn, explicit || unaccepted, dropped);
    if (turn.runState?.state === "cancelling" && attempt.interruptRequestedAt === null) {
      const interrupted: OrchestrationDomainEvent = { type: "attempt.interrupt-requested",
        payload: { runId: run.id, attemptId: attempt.id } };
      this.events.commit({ actorId: "runtime", commandId: `interrupt:${commandFingerprint(attempt.id)}`,
        projectId: run.projectId, threadId: run.threadId, command: interrupted,
        expectedRevision: this.events.revision(run.threadId), events: [interrupted], result: null });
    }
    return null;
  }

  cleanup(identity: { turnId: string; runId: string }, cleanup: "pending" | "confirmed" | "unconfirmed"): void {
    const row = this.events.projection("run", identity.runId);
    if (!row) return;
    const run = orchestrationRunSchema.parse(row.value);
    if (run.turnId !== identity.turnId) throw new Error("Orchestration cleanup identity conflicts.");
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    if (attempt.cleanup === cleanup) return;
    if (cleanup === "pending" && attempt.cleanup === "confirmed") {
      this.replaceAttempt({ runId: run.id, turnId: run.turnId, expectedAttemptId: attempt.id, reason: "retry" });
      return;
    }
    const event: OrchestrationDomainEvent = { type: "attempt.cleanup-changed",
      payload: { runId: run.id, attemptId: attempt.id, cleanup } };
    const revision = this.events.revision(run.threadId);
    this.events.commit({ actorId: "runtime",
      commandId: `cleanup:${commandFingerprint({ attemptId: attempt.id, from: attempt.cleanup, to: cleanup, revision })}`,
      projectId: run.projectId, threadId: run.threadId, command: event,
      expectedRevision: revision, events: [event], result: null });
  }

  replaceAttempt(input: AttemptReplacement): OrchestrationAttempt {
    return this.database.transaction((): OrchestrationAttempt => {
      const row = this.events.projection("run", input.runId);
      if (!row) throw new OrchestrationConflict("scope-conflict");
      const run = orchestrationRunSchema.parse(row.value);
      if (run.turnId !== input.turnId) throw new Error("Orchestration attempt identity conflicts.");
      const priorCleanup = input.priorCleanup ? { priorCleanup: input.priorCleanup } : {};
      const command: JsonValue = { type: "run.attempt-replace", runId: run.id, turnId: run.turnId,
        expectedAttemptId: input.expectedAttemptId, reason: input.reason, priorCleanup: input.priorCleanup ?? null };
      const identity = { actorId: "runtime", projectId: run.projectId, threadId: run.threadId,
        commandId: `attempt-replaced:${commandFingerprint({ expectedAttemptId: input.expectedAttemptId, reason: input.reason })}` };
      const previous = this.events.receipt(identity, command);
      if (previous) return this.attempt((previous.result as { attemptId: string }).attemptId);
      if (run.attemptId !== input.expectedAttemptId) throw new OrchestrationConflict("revision-conflict");
      const replacement: OrchestrationAttempt = { id: randomUUID(), runId: run.id, turnId: run.turnId,
        threadId: run.threadId, providerInstanceId: run.providerInstanceId, status: run.status,
        nativeSessionId: null, nativeThreadId: null, nativeTurnId: null, interruptRequestedAt: null,
        cleanup: "pending", runtimeId: this.runtimeId };
      const event: OrchestrationDomainEvent = { type: "run.attempt-replaced", payload: { runId: run.id,
        attemptId: input.expectedAttemptId, replacement, reason: input.reason, ...priorCleanup } };
      this.events.commit({ ...identity, command, expectedRevision: this.events.revision(run.threadId),
        events: [event], result: { attemptId: replacement.id } });
      return this.attempt(replacement.id);
    }).immediate();
  }

  releaseCleanup(identity: { turnId: string; runId: string }, release: OrchestrationCleanupRelease): boolean {
    const row = this.events.projection("run", identity.runId);
    if (!row) return false;
    const run = orchestrationRunSchema.parse(row.value);
    if (run.turnId !== identity.turnId) throw new Error("Orchestration cleanup identity conflicts.");
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    if (attempt.cleanup === "unconfirmed-released") return true;
    if (attempt.cleanup !== "pending" && attempt.cleanup !== "unconfirmed") return false;
    const event: OrchestrationDomainEvent = { type: "attempt.cleanup-released",
      payload: { runId: run.id, attemptId: attempt.id, release: orchestrationCleanupReleaseSchema.parse(release) } };
    const revision = this.events.revision(run.threadId);
    this.events.commit({ actorId: "runtime",
      commandId: `cleanup-release:${commandFingerprint({ attemptId: attempt.id, revision })}`,
      projectId: run.projectId, threadId: run.threadId, command: event,
      expectedRevision: revision, events: [event], result: null });
    return true;
  }

  reconcile(): void {
    const query = this.database.prepare(`SELECT turns.id FROM agent_turns turns
      JOIN orchestration_v2_entities runs ON runs.kind = 'run' AND runs.id = turns.run_id
      WHERE turns.id > ? AND (json_extract(runs.payload_json, '$.status') <> turns.status
        OR json_extract(runs.payload_json, '$.stateRevision') <> turns.run_state_revision)
      ORDER BY turns.id LIMIT 100`);
    let after = "";
    while (true) {
      const rows = query.all(after) as { id: string }[];
      if (rows.length === 0) break;
      for (const row of rows) this.synchronize(this.access.agentTurn(row.id));
      after = rows.at(-1)!.id;
    }
  }

  startIntent(runId: string): OrchestrationEffect | null {
    return this.effects.get(this.startEffectId(runId));
  }

  claimStart(runId: string): OrchestrationEffect | null {
    return this.effects.claim(this.startEffectId(runId), { passing: [CHECKPOINT_CAPTURE_EFFECT_KIND] });
  }

  attachEffectRuntime(runtime: OrchestrationEffectRuntime): void {
    this.#effectRuntime = runtime;
  }

  captureBarrier(runId: string, timeoutMs = TURN_GIT_ARTIFACT_FINALIZATION_TIMEOUT_MS): Promise<void> | null {
    const runtime = this.#effectRuntime;
    const intent = this.startIntent(runId);
    if (!runtime?.executes(CHECKPOINT_CAPTURE_EFFECT_KIND) || intent?.state !== "pending") return null;
    const captures = this.effects.unsettledBefore(intent.threadId, intent.sequence, [CHECKPOINT_CAPTURE_EFFECT_KIND]);
    if (captures.length === 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(1, timeoutMs));
      timer.unref?.();
    });
    return Promise.race([Promise.allSettled(captures.map((id) => runtime.awaitSettled(id))).then(() => undefined), expired])
      .finally(() => { clearTimeout(timer); });
  }

  dispatchStart(runId: string, dispatch: () => boolean,
    defer?: (barrier: Promise<void>, resume: () => boolean) => boolean): boolean {
    const barrier = defer ? this.captureBarrier(runId) : null;
    if (barrier) return defer!(barrier, () => this.dispatchStart(runId, dispatch));
    const intent = this.startIntent(runId);
    const claim = intent ? this.claimStart(runId) : null;
    if (intent && !claim) return false;
    try {
      if (intent) {
        try {
          this.backings.dispatch(runId);
          this.history.dispatched(runId);
          this.mergeBacks.dispatched(runId);
        } catch (error) {
          // These read the backing, rollback-cursor and merge-back projections before anything is dispatched.
          throw error instanceof z.ZodError ? new OrchestrationStateUnreadable({ cause: error }) : error;
        }
      }
      const accepted = dispatch();
      if (claim) this.effects.settle(claim, accepted
        ? { kind: "succeeded" } : { kind: "failed", code: "start-refused" });
      return accepted;
    } catch (error) {
      if (claim) this.effects.settle(claim, { kind: "failed", code: "start-failed" });
      throw error;
    }
  }

  recover(reconcileCompatibilityProjection: () => void): void {
    this.database.transaction(() => {
      this.effects.recover();
      this.nativeControls.recover();
      reconcileCompatibilityProjection();
      this.reconcile();
    })();
  }

  private attempt(id: string): OrchestrationAttempt {
    return orchestrationAttemptSchema.parse(this.events.projection("attempt", id)?.value);
  }

  private readOnlyWatcher(conversationId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM watcher_links
      WHERE watcher_conversation_id = ? AND status <> 'detached' AND read_only <> 0`).get(conversationId) !== undefined;
  }

  private startEffectId(runId: string): string {
    return `start:${commandFingerprint(runId)}`;
  }
}
