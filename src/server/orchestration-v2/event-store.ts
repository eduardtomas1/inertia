import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { commandFingerprint, durableId, durableJson, durableTimestamp } from "./json";
import {
  OrchestrationConflict,
  type CommandCommit,
  type CommandIdentity,
  type CommandReceipt,
  type CommitResult,
  type JsonValue,
  type OrchestrationEvent,
  type Projection,
  type ProjectEvent,
} from "./types";

interface ReceiptRow {
  actor_id: string; command_id: string; thread_id: string; project_id: string;
  fingerprint: string; first_sequence: number | null; last_sequence: number | null;
  result_json: string; created_at: string;
}
interface EventRow {
  sequence: number; id: string; project_id: string; thread_id: string; revision: number;
  command_id: string; type: string; created_at: string; payload_json: string;
}
interface ProjectionRow {
  kind: string; id: string; project_id: string; thread_id: string;
  revision: number; payload_json: string;
}

function receiptFromRow(row: ReceiptRow): CommandReceipt {
  return {
    actorId: row.actor_id, commandId: row.command_id, threadId: row.thread_id,
    projectId: row.project_id, fingerprint: row.fingerprint,
    firstSequence: row.first_sequence, lastSequence: row.last_sequence,
    result: JSON.parse(row.result_json) as JsonValue, createdAt: row.created_at,
  };
}
function eventFromRow(row: EventRow): OrchestrationEvent {
  return {
    sequence: row.sequence, id: row.id, projectId: row.project_id, threadId: row.thread_id,
    revision: row.revision, commandId: row.command_id, type: row.type,
    createdAt: row.created_at, payload: JSON.parse(row.payload_json) as JsonValue,
  };
}

/**
 * The transaction is the authority boundary: receipt, log, projections and
 * effects either all commit or all roll back. Publication happens afterwards.
 */
export class OrchestrationEventStore {
  constructor(
    private readonly database: Database.Database,
    private readonly project: ProjectEvent,
    readonly runtimeId: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    durableId(runtimeId);
  }

  revision(threadId: string): number {
    const row = this.database.prepare(`SELECT COALESCE(MAX(revision), 0) AS revision
      FROM orchestration_v2_events WHERE thread_id = ?`).get(threadId) as { revision: number };
    return row.revision;
  }

  projection(kind: string, id: string): Projection | null {
    const row = this.database.prepare(`SELECT * FROM orchestration_v2_entities
      WHERE kind = ? AND id = ?`).get(kind, id) as ProjectionRow | undefined;
    return row ? {
      kind: row.kind, id: row.id, projectId: row.project_id, threadId: row.thread_id,
      revision: row.revision, value: JSON.parse(row.payload_json) as JsonValue,
    } : null;
  }

  receipt(identity: CommandIdentity, command: JsonValue): CommandReceipt | null {
    const row = this.database.prepare(`SELECT * FROM orchestration_v2_receipts
      WHERE actor_id = ? AND command_id = ?`).get(identity.actorId, identity.commandId) as ReceiptRow | undefined;
    if (!row) return null;
    if (row.project_id !== identity.projectId || row.thread_id !== identity.threadId
      || row.fingerprint !== commandFingerprint(command)) {
      throw new OrchestrationConflict("command-conflict");
    }
    return receiptFromRow(row);
  }

  /** The optional compatibility projection must be synchronous and use this same database. */
  commit(input: CommandCommit, compatibilityProjection?: () => void): CommitResult {
    for (const value of [input.actorId, input.commandId, input.projectId, input.threadId]) durableId(value);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error("Invalid expected orchestration revision.");
    }
    if (input.events.length > 256 || (input.effects?.length ?? 0) > 256) {
      throw new Error("An orchestration commit exceeds its batch limit.");
    }
    const fingerprint = commandFingerprint(input.command);
    const resultJson = durableJson(input.result, 262_144);
    const payloads = input.events.map((event) => {
      durableId(event.type);
      return durableJson(event.payload);
    });
    if (payloads.reduce((total, payload) => total + Buffer.byteLength(payload), 0) > 4_194_304) {
      throw new Error("An orchestration event batch is too large.");
    }
    const effects = (input.effects ?? []).map((effect) => {
      durableId(effect.id);
      durableId(effect.kind);
      if (!Number.isSafeInteger(effect.eventIndex) || effect.eventIndex < 0 || effect.eventIndex >= input.events.length) {
        throw new Error("An effect must belong to an event in its commit.");
      }
      return { ...effect, json: durableJson(effect.payload) };
    });
    return this.database.transaction((): CommitResult => {
      const existing = this.receipt(input, input.command);
      if (existing) return { replayed: true, receipt: existing, events: [] };
      const head = this.database.prepare(`SELECT project_id, revision FROM orchestration_v2_events
        WHERE thread_id = ? ORDER BY revision DESC LIMIT 1`).get(input.threadId) as
        { project_id: string; revision: number } | undefined;
      if (head && head.project_id !== input.projectId) throw new OrchestrationConflict("scope-conflict");
      if ((head?.revision ?? 0) !== input.expectedRevision) throw new OrchestrationConflict("revision-conflict");
      const now = durableTimestamp(this.clock());
      const events: OrchestrationEvent[] = [];
      for (const [index, draft] of input.events.entries()) {
        const id = randomUUID();
        const revision = input.expectedRevision + index + 1;
        const inserted = this.database.prepare(`INSERT INTO orchestration_v2_events
          (id, project_id, thread_id, revision, command_id, type, created_at, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.threadId,
          revision, input.commandId, draft.type, now, payloads[index]!);
        const event: OrchestrationEvent = { ...draft, id, sequence: Number(inserted.lastInsertRowid),
          projectId: input.projectId, threadId: input.threadId, revision,
          commandId: input.commandId, createdAt: now };
        this.applyProjection(event);
        events.push(event);
      }
      for (const effect of effects) {
        this.database.prepare(`INSERT INTO orchestration_v2_effects
          (id, project_id, thread_id, event_sequence, kind, replay_policy, runtime_id,
           state, available_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(effect.id, input.projectId, input.threadId, events[effect.eventIndex]!.sequence,
            effect.kind, effect.replayPolicy, this.runtimeId, now, effect.json);
      }
      compatibilityProjection?.();
      const receipt: CommandReceipt = { actorId: input.actorId, commandId: input.commandId,
        threadId: input.threadId, projectId: input.projectId, fingerprint,
        firstSequence: events[0]?.sequence ?? null,
        lastSequence: events.at(-1)?.sequence ?? null, result: input.result, createdAt: now };
      this.database.prepare(`INSERT INTO orchestration_v2_receipts
        (actor_id, command_id, thread_id, project_id, fingerprint,
         first_sequence, last_sequence, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(receipt.actorId, receipt.commandId, receipt.threadId, receipt.projectId, fingerprint,
          receipt.firstSequence, receipt.lastSequence, resultJson, now);
      return { replayed: false, receipt, events };
    }).immediate();
  }

  readEvents(input: { projectId: string; threadId?: string; afterSequence?: number; limit?: number }): OrchestrationEvent[] {
    const after = input.afterSequence ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Invalid orchestration event page.");
    }
    const rows = input.threadId === undefined
      ? this.database.prepare(`SELECT * FROM orchestration_v2_events WHERE project_id = ?
          AND sequence > ? ORDER BY sequence LIMIT ?`).all(input.projectId, after, limit)
      : this.database.prepare(`SELECT * FROM orchestration_v2_events WHERE project_id = ?
          AND thread_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(input.projectId, input.threadId, after, limit);
    return (rows as EventRow[]).map(eventFromRow);
  }

  /** Offline recovery only: effects and receipts are never re-executed by rebuilding projections. */
  rebuildProjections(): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM orchestration_v2_entities").run();
      let after = 0;
      while (true) {
        const rows = this.database.prepare(`SELECT * FROM orchestration_v2_events
          WHERE sequence > ? ORDER BY sequence LIMIT 100`).all(after) as EventRow[];
        if (rows.length === 0) break;
        for (const row of rows) this.applyProjection(eventFromRow(row));
        after = rows.at(-1)!.sequence;
      }
    }).immediate();
  }

  private applyProjection(event: OrchestrationEvent): void {
    for (const projection of this.project(event, (kind, id) => this.projection(kind, id))) {
      durableId(projection.kind);
      durableId(projection.id);
      const previous = this.projection(projection.kind, projection.id);
      if (previous && (previous.threadId !== event.threadId || previous.projectId !== event.projectId)) {
        throw new OrchestrationConflict("scope-conflict");
      }
      this.database.prepare(`INSERT INTO orchestration_v2_entities
        (kind, id, project_id, thread_id, revision, payload_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json`)
        .run(projection.kind, projection.id, event.projectId, event.threadId,
          event.revision, durableJson(projection.value));
    }
  }
}
