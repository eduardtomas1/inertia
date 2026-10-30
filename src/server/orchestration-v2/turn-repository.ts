import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { AgentTurn, ChatMessage, Conversation } from "../../shared/contracts";
import { modelSelectionSchema } from "../../shared/model-routing";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { orchestrationAttemptSchema, orchestrationRunSchema, type OrchestrationDomainEvent } from "../../shared/orchestration-v2";
import type { BeginAgentTurnInput, NewConversationOptions } from "../persistence/types";
import { OrchestrationEffectOutbox } from "./effect-outbox";
import { OrchestrationEventStore } from "./event-store";
import { commandFingerprint, durableJson } from "./json";
import { projectOrchestrationEvent } from "./projector";
import { readPortableContinuationHistory } from "./portable-history-source";
import { ProviderBackingRepository } from "./backing-repository";
import { NativeBoundaryRepository } from "./native-boundary-repository";
import { NativeControlRepository } from "./native-control-repository";
import { ForkRepository } from "./fork-repository";
import { HistoryRollbackRepository } from "./history-rollback-repository";
import { MergeBackRepository, type MergeBackAccess } from "./merge-back-repository";
import { OrchestrationCommandLanes } from "./command-lanes";
import { providerInstanceId } from "./provider-instance";
import { OrchestrationConflict, type CommandSource, type JsonValue, type OrchestrationEffect } from "./types";

interface TurnProjectionAccess extends MergeBackAccess {
  conversation(id: string): Conversation;
  conversationPath(id: string): string;
  agentTurn(id: string): AgentTurn;
  message(id: string): ChatMessage;
  createConversation(projectId: string, title: string, options: NewConversationOptions): Conversation;
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
  readonly lanes = new OrchestrationCommandLanes();

  constructor(
    private readonly database: Database.Database,
    private readonly access: TurnProjectionAccess,
    readonly runtimeId: string = randomUUID(),
    systemBootId: string | null = null,
  ) {
    this.events = new OrchestrationEventStore(database, projectOrchestrationEvent, runtimeId);
    this.effects = new OrchestrationEffectOutbox(database, runtimeId);
    this.backings = new ProviderBackingRepository(database, this.events);
    this.nativeBoundaries = new NativeBoundaryRepository(database, this.events);
    this.history = new HistoryRollbackRepository(database, this.events);
    this.nativeControls = new NativeControlRepository(database, this.events, this.effects, this.history, runtimeId, systemBootId);
    this.forks = new ForkRepository(database, this.events, this.nativeBoundaries, this.history, access);
    this.mergeBacks = new MergeBackRepository(database, this.events, this.forks, this.history, access);
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
      const { id: _turnId, runId: _runId, requestedAt: _requestedAt, nativeContinuation, ...intent } = input;
      const command = source?.command ?? JSON.parse(JSON.stringify({ type: "run.start", ...intent })) as JsonValue;
      const previous = this.events.receipt(identity, command);
      if (previous) {
        const result = previous.result as { turnId: string; messageId: string };
        return { turn: this.access.agentTurn(result.turnId), message: this.access.message(result.messageId) };
      }
      if (this.hasPendingCleanup(conversation.id)) throw new OrchestrationConflict("cleanup-pending");
      if (this.forks.get(conversation.id)?.transfer === "pending") {
        this.nativeControls.selectPortable(conversation.id, conversation.projectId, "portable-first-send");
      }
      if (input.providerSessionBefore && input.continuationIdentity) {
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
      if (input.contextHandoff) events.push(this.backings.preparation(turn.runId, attemptId,
        conversation.id, turn.requestedAt, input.contextHandoff));
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

  acknowledge(runId: string): void {
    this.backings.acknowledge(runId);
    this.history.acknowledge(runId);
    this.mergeBacks.acknowledge(runId);
  }

  hasPendingCleanup(threadId: string): boolean {
    if (this.nativeControls.locked(threadId)) return true;
    return this.database.prepare(`SELECT 1 FROM orchestration_v2_entities
      WHERE thread_id = ? AND kind = 'attempt'
        AND json_extract(payload_json, '$.cleanup') IN ('pending','unconfirmed') LIMIT 1`)
      .get(threadId) !== undefined;
  }

  portableHistory(input: Parameters<typeof readPortableContinuationHistory>[1]) {
    this.access.conversation(input.threadId);
    return readPortableContinuationHistory(this.database, input);
  }

  lifecycle<T>(turnId: string, updateCompatibilityProjection: () => T): T {
    return this.database.transaction(() => {
      const result = updateCompatibilityProjection();
      this.synchronize(this.access.agentTurn(turnId));
      return result;
    }).immediate();
  }

  admitPair<T>(create: () => [T, T], link: (pair: [T, T]) => void): [T, T] {
    return this.database.transaction(() => {
      const pair = create();
      link(pair);
      return pair;
    })();
  }

  synchronize(turn: AgentTurn): void {
    const previous = this.events.projection("run", turn.runId);
    if (!previous) return; // Imported/pre-V2 history has no invented execution authority.
    const run = orchestrationRunSchema.parse(previous.value);
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    const event: OrchestrationDomainEvent = { type: "run.status-changed", payload: {
      runId: turn.runId, attemptId: run.attemptId, status: turn.status,
      executionState: turn.runState?.state ?? turn.status,
      providerState: turn.runState?.providerState ?? null,
      stateRevision: turn.runState?.revision ?? run.stateRevision + 1,
      startedAt: turn.startedAt, completedAt: turn.completedAt,
      terminalMessageId: turn.terminalAssistantMessageId,
      nativeSessionId: turn.providerSessionAfter ?? turn.providerSessionBefore,
    } };
    const before = { ...event.payload, status: run.status, stateRevision: run.stateRevision,
      executionState: run.executionState, providerState: run.providerState,
      startedAt: run.startedAt, completedAt: run.completedAt, terminalMessageId: run.terminalMessageId,
      nativeSessionId: attempt.nativeSessionId };
    if (durableJson(before) === durableJson(event.payload)) return;
    this.events.commit({ actorId: "runtime", commandId: `lifecycle:${commandFingerprint({ turnId: turn.id, ...event.payload })}`,
      projectId: run.projectId, threadId: run.threadId, command: event,
      expectedRevision: this.events.revision(run.threadId), events: [event], result: null });
    if (isAgentTurnTerminalStatus(turn.status)) this.effects.retirePending(this.startEffectId(turn.runId), "run-settled");
    this.backings.settle(turn);
    this.history.settleRun(turn, (backing) => this.backings.invalidate(backing, "uncertain-delivery"));
    this.mergeBacks.settleRun(turn);
    if (turn.runState?.state === "cancelling" && attempt.interruptRequestedAt === null) {
      const interrupted: OrchestrationDomainEvent = { type: "attempt.interrupt-requested",
        payload: { runId: run.id, attemptId: attempt.id } };
      this.events.commit({ actorId: "runtime", commandId: `interrupt:${commandFingerprint(attempt.id)}`,
        projectId: run.projectId, threadId: run.threadId, command: interrupted,
        expectedRevision: this.events.revision(run.threadId), events: [interrupted], result: null });
    }
  }

  cleanup(identity: { turnId: string; runId: string }, cleanup: "pending" | "confirmed" | "unconfirmed"): void {
    const row = this.events.projection("run", identity.runId);
    if (!row) return;
    const run = orchestrationRunSchema.parse(row.value);
    if (run.turnId !== identity.turnId) throw new Error("Orchestration cleanup identity conflicts.");
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    if (attempt.cleanup === cleanup) return;
    const event: OrchestrationDomainEvent = cleanup === "pending" && attempt.cleanup === "confirmed"
      ? { type: "run.attempt-replaced", payload: { runId: run.id, attemptId: attempt.id,
          replacement: { ...attempt, id: randomUUID(), status: run.status, cleanup: "pending",
            nativeSessionId: null, nativeThreadId: null, nativeTurnId: null,
            interruptRequestedAt: null, runtimeId: this.runtimeId } } }
      : { type: "attempt.cleanup-changed", payload: { runId: run.id, attemptId: attempt.id, cleanup } };
    this.events.commit({ actorId: "runtime", commandId: `cleanup:${commandFingerprint({ attemptId: attempt.id, cleanup, type: event.type })}`,
      projectId: run.projectId, threadId: run.threadId, command: event,
      expectedRevision: this.events.revision(run.threadId), events: [event], result: null });
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
    return this.effects.claim(this.startEffectId(runId));
  }

  dispatchStart(runId: string, dispatch: () => boolean): boolean {
    const intent = this.startIntent(runId);
    const claim = intent ? this.claimStart(runId) : null;
    if (intent && !claim) return false;
    try {
      if (intent) {
        this.backings.dispatch(runId);
        this.history.dispatched(runId);
        this.mergeBacks.dispatched(runId);
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

  private startEffectId(runId: string): string {
    return `start:${commandFingerprint(runId)}`;
  }
}
