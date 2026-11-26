import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { AgentActivity } from "../../shared/contracts";
import { nativeControlSchema, type NativeControl, type NativeControlEvent } from "../../shared/orchestration-native-control";
import type { NativeConversationResult } from "../provider/native-conversation-operations";
import type { OrchestrationEventStore } from "./event-store";
import type { OrchestrationEffectOutbox } from "./effect-outbox";
import { CHECKPOINT_CAPTURE_EFFECT_KIND } from "./effect-runtime";
import { commandFingerprint, durableJson } from "./json";
import { OrchestrationConflict, type CommandSource, type JsonValue, type OrchestrationEffect } from "./types";
import { forksLiveSource, nativeControlLockResources } from "./native-control-projector";
import type { HistoryRollbackRepository } from "./history-rollback-repository";

export const NATIVE_FORK_FALLBACK_NOTICE_TITLE = "Native session fork failed — continuing portably";

export function nativeForkFailureNotice(result: NativeConversationResult): { title: string; detail: string } | null {
  if (result.status === "failed") {
    if (result.reason === "cleanup-unconfirmed") return null;
    if (result.reason === "deadline") {
      return {
        title: NATIVE_FORK_FALLBACK_NOTICE_TITLE,
        detail: "The provider timed out while forking the native session. This fork will continue portably with copied history.",
      };
    }
    if (result.reason === "cancelled") {
      return {
        title: NATIVE_FORK_FALLBACK_NOTICE_TITLE,
        detail: "The native session fork was cancelled before it finished. This fork will continue portably with copied history.",
      };
    }
    return {
      title: NATIVE_FORK_FALLBACK_NOTICE_TITLE,
      detail: "The provider could not fork the native session. This fork will continue portably with copied history.",
    };
  }
  if (result.status === "rejected") {
    return {
      title: NATIVE_FORK_FALLBACK_NOTICE_TITLE,
      detail: "The provider rejected the native session fork. This fork will continue portably with copied history.",
    };
  }
  return null;
}

export function nativeForkNoticeRunId(operationId: string): string {
  return `native-fork:${operationId}`;
}

/** Durable fences cover both application conversations and the exact native source. */
export class NativeControlRepository {
  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore,
    private readonly effects: OrchestrationEffectOutbox, private readonly history: HistoryRollbackRepository,
    private readonly runtimeId: string, private readonly systemBootId: string | null = null) {}

  locked(threadId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM orchestration_v2_entities WHERE kind = 'native-control-lock'
      AND json_extract(payload_json, '$.resourceId') = ? AND json_extract(payload_json, '$.locked') = 1 LIMIT 1`).get(threadId) !== undefined;
  }

  /** The control that holds a locked resource, if any. */
  lockHolder(resourceId: string): NativeControl | null {
    const row = this.database.prepare(`SELECT json_extract(payload_json, '$.operationId') AS operationId
      FROM orchestration_v2_entities WHERE kind = 'native-control-lock'
        AND json_extract(payload_json, '$.resourceId') = ? AND json_extract(payload_json, '$.locked') = 1 LIMIT 1`)
      .get(resourceId) as { operationId: string } | undefined;
    return row ? this.get(row.operationId) : null;
  }

  get(id: string): NativeControl | null {
    const row = this.events.projection("native-control", id);
    return row ? nativeControlSchema.parse(row.value) : null;
  }

  forkBacking(threadId: string): NativeControl | null {
    const row = this.events.projection("fork-native-backing", threadId);
    return row ? nativeControlSchema.parse(row.value) : null;
  }

  selectPortable(threadId: string, projectId: string, reason: string): void {
    if (this.locked(threadId)) throw new OrchestrationConflict("cleanup-pending");
    const event = { type: "fork.portable-selected", payload: { reason } } as const;
    this.commit(threadId, projectId, event);
  }

  start(input: Omit<NativeControl, "runtimeId" | "systemBootId" | "state" | "backing" | "reason" | "createdAt" | "updatedAt">,
    source?: CommandSource, result: JsonValue = null): OrchestrationEffect {
    return this.database.transaction(() => {
      // A live fork starts beside the source's running turn; only the target must be idle.
      const idle = forksLiveSource(input) ? [input.threadId] : [input.threadId, input.request.source.identity.conversationId];
      for (const threadId of idle) {
        const active = this.database.prepare(`SELECT 1 FROM orchestration_v2_entities WHERE thread_id = ? AND
          ((kind = 'thread' AND json_extract(payload_json, '$.activeRunId') IS NOT NULL)
            OR (kind = 'attempt' AND json_extract(payload_json, '$.cleanup') IN ('pending','unconfirmed','unconfirmed-released'))) LIMIT 1`).get(threadId);
        if (active || this.locked(threadId)) throw new OrchestrationConflict("cleanup-pending");
      }
      const timestamp = new Date().toISOString();
      const control = nativeControlSchema.parse({ ...input, runtimeId: this.runtimeId, systemBootId: this.systemBootId,
        state: "running", backing: null, reason: null, createdAt: timestamp, updatedAt: timestamp });
      if (nativeControlLockResources(control).some((id) => this.locked(id))) throw new OrchestrationConflict("cleanup-pending");
      const event = { type: "native.control-started", payload: control } as const;
      const effectId = `native-control:${control.id}`;
      this.events.commit({ actorId: source?.actorId ?? "runtime", commandId: source?.commandId ?? effectId, projectId: control.projectId,
        threadId: control.threadId, command: source?.command ?? event, expectedRevision: this.events.revision(control.threadId),
        events: [event], effects: [{ id: effectId, eventIndex: 0, kind: `native.${control.request.kind}`, replayPolicy: "process-bound",
          payload: { operationId: control.id } }], result: source ? result : { operationId: control.id } });
      const effect = this.effects.claim(effectId, { passing: [CHECKPOINT_CAPTURE_EFFECT_KIND] });
      if (!effect) throw new OrchestrationConflict("revision-conflict");
      return effect;
    }).immediate();
  }

  settle(effect: OrchestrationEffect, result: NativeConversationResult): NativeControl {
    const settled = this.database.transaction(() => {
      const control = this.claimed(effect);
      const rollback = control.request.kind === "rollback";
      if (result.operationId !== control.id || result.targetConversationId !== (rollback ? undefined : control.threadId)
        || durableJson({ ...result.identity }) !== durableJson(control.request.source.identity)) {
        throw new OrchestrationConflict("scope-conflict");
      }
      // A fork only creates a new native branch. Once cleanup is confirmed,
      // failed/unsupported branches can use the immutable portable snapshot.
      const state = result.status === "completed" && (rollback || result.effect === "native-fork") ? "completed"
        : result.status === "failed" && result.reason === "cleanup-unconfirmed" ? "uncertain" : "portable";
      const backing = state === "completed" && result.status === "completed" ? result.backing : null;
      const event: NativeControlEvent = { type: "native.control-settled", payload: {
        id: control.id, state, backing, reason: result.status === "completed" ? null
          : result.status === "failed" ? result.reason : result.status,
      } };
      this.commit(control.threadId, control.projectId, event);
      if (rollback && state !== "uncertain") this.history.applySettled(control, state);
      if (!rollback && backing) {
        const changed = this.database.prepare(`UPDATE conversations SET provider_session_id = ?, continuation_identity_json = ?
          WHERE id = ? AND project_id = ? AND NOT EXISTS (SELECT 1 FROM agent_turns WHERE conversation_id = ?)`)
          .run(backing.nativeConversationId, JSON.stringify(control.continuationIdentity), control.threadId,
            control.projectId, control.threadId).changes;
        if (changed !== 1) throw new OrchestrationConflict("revision-conflict");
      }
      if (!this.effects.settle(effect, state === "completed" ? { kind: "succeeded" }
        : { kind: "failed", code: state === "uncertain" ? "cleanup-unconfirmed" : "portable-fallback" })) {
        throw new OrchestrationConflict("revision-conflict");
      }
      return this.get(control.id)!;
    }).immediate();
    if (settled.request.kind === "fork" && settled.state === "portable") {
      const notice = nativeForkFailureNotice(result);
      if (notice) this.recordForkFallbackNotice(settled.threadId, settled.id, notice);
    }
    return settled;
  }

  /** Non-blocking visible timeline notice when a provider-side native fork falls back to portable history. */
  recordForkFallbackNotice(
    conversationId: string,
    operationId: string,
    notice: { title: string; detail: string },
  ): AgentActivity | null {
    const runId = nativeForkNoticeRunId(operationId);
    try {
      const existing = this.database.prepare(`SELECT id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at
        FROM activities WHERE conversation_id = ? AND run_id = ? LIMIT 1`)
        .get(conversationId, runId) as {
          id: string; conversation_id: string; run_id: string; turn_id: string | null;
          kind: AgentActivity["kind"]; title: string; detail: string | null;
          status: AgentActivity["status"]; created_at: string;
        } | undefined;
      if (existing) {
        return {
          id: existing.id, conversationId: existing.conversation_id, runId: existing.run_id,
          turnId: existing.turn_id, kind: existing.kind, title: existing.title,
          detail: existing.detail, status: existing.status, createdAt: existing.created_at,
        };
      }
      const record: AgentActivity = {
        id: randomUUID(),
        conversationId,
        runId,
        turnId: null,
        kind: "status",
        title: notice.title,
        detail: notice.detail,
        status: "completed",
        createdAt: new Date().toISOString(),
      };
      this.database.prepare(`INSERT INTO activities
        (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at)
        VALUES (@id, @conversationId, @runId, @turnId, @kind, @title, @detail, @status, @createdAt)`).run(record);
      return record;
    } catch {
      return null;
    }
  }

  uncertain(effect: OrchestrationEffect, reason = "operation-unconfirmed"): void {
    this.database.transaction(() => {
      const control = this.claimed(effect);
      this.commit(control.threadId, control.projectId, { type: "native.control-settled",
        payload: { id: control.id, state: "uncertain", backing: null, reason } });
      if (!this.effects.settle(effect, { kind: "failed", code: reason })) throw new OrchestrationConflict("revision-conflict");
    }).immediate();
  }

  recover(): void {
    const rows = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE kind = 'native-control' AND json_extract(payload_json, '$.runtimeId') <> ?
        AND json_extract(payload_json, '$.state') = 'running'`).all(this.runtimeId) as { payload_json: string }[];
    for (const row of rows) {
      const control = nativeControlSchema.parse(JSON.parse(row.payload_json));
      this.commit(control.threadId, control.projectId, { type: "native.control-settled",
        payload: { id: control.id, state: "uncertain", backing: null, reason: "runtime-lost" } });
    }
  }

  /** Only exact process-cleanup evidence may release an ambiguous operation. */
  reconcileCleanup(input: { confirmedRuntimeGenerationIds: ReadonlySet<string>; currentSystemBootId: string;
    priorBootCleanupConfirmed: boolean }): void {
    const rows = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities WHERE kind = 'native-control'
      AND json_extract(payload_json, '$.state') = 'uncertain'`).all() as { payload_json: string }[];
    for (const row of rows) {
      const control = nativeControlSchema.parse(JSON.parse(row.payload_json));
      if (control.runtimeId === this.runtimeId) continue;
      if (input.confirmedRuntimeGenerationIds.has(control.runtimeId) || input.priorBootCleanupConfirmed
        && control.systemBootId !== null && control.systemBootId !== input.currentSystemBootId) {
        this.confirmCleanup(control.id, control.runtimeId);
      }
    }
  }

  confirmCleanup(id: string, runtimeId: string): void {
    this.database.transaction(() => {
      const control = this.get(id);
      if (!control || control.runtimeId !== runtimeId || control.state !== "uncertain") throw new OrchestrationConflict("scope-conflict");
      this.commit(control.threadId, control.projectId, { type: "native.control-settled",
        payload: { id, state: "portable", backing: null, reason: "cleanup-confirmed" } });
      if (control.request.kind === "rollback") this.history.applySettled(control, "portable");
    }).immediate();
  }

  private claimed(effect: OrchestrationEffect): NativeControl {
    const current = this.effects.get(effect.id);
    const id = (effect.payload as { operationId: string }).operationId;
    const control = this.get(id);
    if (!current || !effect.claimId || current.claimId !== effect.claimId || current.state !== "running"
      || current.runtimeId !== this.runtimeId || current.threadId !== control?.threadId
      || control.runtimeId !== this.runtimeId || control.state !== "running") throw new OrchestrationConflict("revision-conflict");
    return control;
  }

  private commit(threadId: string, projectId: string, event: NativeControlEvent): void {
    const revision = this.events.revision(threadId);
    this.events.commit({ actorId: "runtime", commandId: `native:${commandFingerprint({ threadId, projectId, event, revision })}`,
      projectId, threadId, command: event, expectedRevision: revision, events: [event], result: null });
  }
}
