import type Database from "better-sqlite3";

import { nativeControlSchema, type NativeControl, type NativeControlEvent } from "../../shared/orchestration-native-control";
import type { NativeConversationResult } from "../provider/native-conversation-operations";
import type { OrchestrationEventStore } from "./event-store";
import type { OrchestrationEffectOutbox } from "./effect-outbox";
import { commandFingerprint, durableJson } from "./json";
import { OrchestrationConflict, type OrchestrationEffect } from "./types";
import { nativeControlLockResources } from "./native-control-projector";

/** Durable fences cover both application conversations and the exact native source. */
export class NativeControlRepository {
  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore,
    private readonly effects: OrchestrationEffectOutbox, private readonly runtimeId: string,
    private readonly systemBootId: string | null = null) {}

  locked(threadId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM orchestration_v2_entities WHERE kind = 'native-control-lock'
      AND json_extract(payload_json, '$.resourceId') = ? AND json_extract(payload_json, '$.locked') = 1 LIMIT 1`).get(threadId) !== undefined;
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

  start(input: Omit<NativeControl, "runtimeId" | "systemBootId" | "state" | "backing" | "reason" | "createdAt" | "updatedAt">): OrchestrationEffect {
    return this.database.transaction(() => {
      for (const threadId of [input.threadId, input.request.source.identity.conversationId]) {
        const active = this.database.prepare(`SELECT 1 FROM orchestration_v2_entities WHERE thread_id = ? AND
          ((kind = 'thread' AND json_extract(payload_json, '$.activeRunId') IS NOT NULL)
            OR (kind = 'attempt' AND json_extract(payload_json, '$.cleanup') IN ('pending','unconfirmed'))) LIMIT 1`).get(threadId);
        if (active || this.locked(threadId)) throw new OrchestrationConflict("cleanup-pending");
      }
      const timestamp = new Date().toISOString();
      const control = nativeControlSchema.parse({ ...input, runtimeId: this.runtimeId, systemBootId: this.systemBootId,
        state: "running", backing: null, reason: null, createdAt: timestamp, updatedAt: timestamp });
      if (nativeControlLockResources(control).some((id) => this.locked(id))) throw new OrchestrationConflict("cleanup-pending");
      const event = { type: "native.control-started", payload: control } as const;
      const effectId = `native-control:${control.id}`;
      this.events.commit({ actorId: "runtime", commandId: effectId, projectId: control.projectId,
        threadId: control.threadId, command: event, expectedRevision: this.events.revision(control.threadId),
        events: [event], effects: [{ id: effectId, eventIndex: 0, kind: "native.fork", replayPolicy: "process-bound",
          payload: { operationId: control.id } }], result: { operationId: control.id } });
      const effect = this.effects.claim(effectId);
      if (!effect) throw new OrchestrationConflict("revision-conflict");
      return effect;
    }).immediate();
  }

  settle(effect: OrchestrationEffect, result: NativeConversationResult): NativeControl {
    return this.database.transaction(() => {
      const control = this.claimed(effect);
      if (result.operationId !== control.id || result.targetConversationId !== control.threadId
        || durableJson({ ...result.identity }) !== durableJson(control.request.source.identity)) {
        throw new OrchestrationConflict("scope-conflict");
      }
      // A fork only creates a new native branch. Once cleanup is confirmed,
      // failed/unsupported branches can use the immutable portable snapshot.
      const state = result.status === "completed" && result.effect === "native-fork" ? "completed"
        : result.status === "failed" && result.reason === "cleanup-unconfirmed" ? "uncertain" : "portable";
      const backing = state === "completed" && result.status === "completed" ? result.backing : null;
      const event: NativeControlEvent = { type: "native.control-settled", payload: {
        id: control.id, state, backing, reason: result.status === "completed" ? null
          : result.status === "failed" ? result.reason : result.status,
      } };
      this.commit(control.threadId, control.projectId, event);
      if (backing) {
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
    const control = this.get(id);
    if (!control || control.runtimeId !== runtimeId || control.state !== "uncertain") throw new OrchestrationConflict("scope-conflict");
    this.commit(control.threadId, control.projectId, { type: "native.control-settled",
      payload: { id, state: "portable", backing: null, reason: "cleanup-confirmed" } });
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
    this.events.commit({ actorId: "runtime", commandId: `native:${commandFingerprint({ event, revision })}`,
      projectId, threadId, command: event, expectedRevision: revision, events: [event], result: null });
  }
}
