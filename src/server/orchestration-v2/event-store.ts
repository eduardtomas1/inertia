import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { commandFingerprint, durableId, durableJson, durableTimestamp } from "./json";
import { ORCHESTRATION_V2_PROJECTION_VERSION } from "./projector";
import {
  OrchestrationCommandRejected,
  OrchestrationConflict,
  type CommandCommit,
  type CommandIdentity,
  type CommandReceipt,
  type CommandRejection,
  type CommitResult,
  type JsonValue,
  type OrchestrationEvent,
  type Projection,
  type ProjectionReadable,
  type ProjectionVerification,
  type ProjectionVerificationOptions,
  type ProjectEvent,
  type UnreadableProjection,
} from "./types";

const PROJECTION_NAME = "orchestration-v2";
const REBUILD_PAGE_SIZE = 500;
const VERIFY_PAGE_SIZE = 500;
const VERIFY_REPORT_LIMIT = 100;
const MAX_REJECTION_ERROR_LENGTH = 1_000;
const VERIFIED_PROJECTION_KINDS = ["thread", "run", "attempt"] as const;

interface ReceiptRow {
  actor_id: string; command_id: string; thread_id: string; project_id: string;
  fingerprint: string; first_sequence: number | null; last_sequence: number | null;
  result_json: string; created_at: string;
  status?: string | null; error?: string | null; command_type?: string | null;
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
    status: row.status === "rejected" ? "rejected" : "accepted",
    error: row.error ?? null, commandType: row.command_type ?? null,
  };
}

function validCommandType(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    durableId(value);
    return true;
  } catch {
    return false;
  }
}

function resolvedCommandType(input: CommandCommit): string {
  if (input.commandType !== undefined) return durableId(input.commandType);
  const command = input.command;
  const declared = command !== null && typeof command === "object" && !Array.isArray(command)
    ? (command as { readonly [key: string]: JsonValue }).type
    : undefined;
  if (validCommandType(declared)) return declared;
  const first = input.events[0]?.type;
  return validCommandType(first) ? first : "unknown";
}

function boundedRejectionError(error: string): string {
  const bounded = Array.from(error.trim()).slice(0, MAX_REJECTION_ERROR_LENGTH).join("");
  return bounded.length > 0 ? bounded : "The command was rejected.";
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
    private readonly onEffectsCommitted: (() => void) | null = null,
    readonly projectionVersion: number = ORCHESTRATION_V2_PROJECTION_VERSION,
    private readonly projectionReadable: ProjectionReadable | null = null,
  ) {
    durableId(runtimeId);
    if (!Number.isSafeInteger(projectionVersion) || projectionVersion < 0) {
      throw new Error("Invalid orchestration projection version.");
    }
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
    const row = this.receiptRow(identity);
    if (!row) return null;
    if (row.project_id !== identity.projectId || row.thread_id !== identity.threadId
      || row.fingerprint !== commandFingerprint(command)) {
      throw new OrchestrationConflict("command-conflict");
    }
    const receipt = receiptFromRow(row);
    if (receipt.status === "rejected") {
      throw new OrchestrationCommandRejected(receipt.commandId, receipt.error ?? "The command was rejected.");
    }
    return receipt;
  }

  reject(input: CommandRejection): CommandReceipt {
    for (const value of [input.actorId, input.commandId, input.projectId, input.threadId]) durableId(value);
    const commandType = durableId(input.commandType);
    const error = boundedRejectionError(input.error);
    const fingerprint = commandFingerprint(input.command);
    return this.database.transaction((): CommandReceipt => {
      const existing = this.receiptRow(input);
      if (existing) return receiptFromRow(existing);
      const now = durableTimestamp(this.clock());
      this.database.prepare(`INSERT INTO orchestration_v2_receipts
        (actor_id, command_id, thread_id, project_id, fingerprint, first_sequence, last_sequence,
         result_json, created_at, status, error, command_type)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, 'null', ?, 'rejected', ?, ?)`)
        .run(input.actorId, input.commandId, input.threadId, input.projectId, fingerprint, now, error, commandType);
      return { actorId: input.actorId, commandId: input.commandId, threadId: input.threadId,
        projectId: input.projectId, fingerprint, firstSequence: null, lastSequence: null, result: null,
        createdAt: now, status: "rejected", error, commandType };
    }).immediate();
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
    const commandType = resolvedCommandType(input);
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
    const committed = this.database.transaction((): CommitResult => {
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
        lastSequence: events.at(-1)?.sequence ?? null, result: input.result, createdAt: now,
        status: "accepted", error: null, commandType };
      this.database.prepare(`INSERT INTO orchestration_v2_receipts
        (actor_id, command_id, thread_id, project_id, fingerprint,
         first_sequence, last_sequence, result_json, created_at, status, error, command_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?)`)
        .run(receipt.actorId, receipt.commandId, receipt.threadId, receipt.projectId, fingerprint,
          receipt.firstSequence, receipt.lastSequence, resultJson, now, commandType);
      if (receipt.lastSequence !== null) {
        this.database.prepare(`UPDATE orchestration_v2_projection_metadata
          SET last_sequence = ?, updated_at = ? WHERE projection_name = ?`)
          .run(receipt.lastSequence, now, PROJECTION_NAME);
      }
      return { replayed: false, receipt, events };
    }).immediate();
    if (!committed.replayed && effects.length > 0) this.onEffectsCommitted?.();
    return committed;
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
  rebuildProjections(rebuildCompatibilityProjections?: () => void): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM orchestration_v2_entities").run();
      const page = this.database.prepare(`SELECT * FROM orchestration_v2_events
        WHERE sequence > ? ORDER BY sequence LIMIT ?`);
      let after = 0;
      while (true) {
        const rows = page.all(after, REBUILD_PAGE_SIZE) as EventRow[];
        if (rows.length === 0) break;
        for (const row of rows) this.applyProjection(eventFromRow(row));
        after = rows.at(-1)!.sequence;
        if (rows.length < REBUILD_PAGE_SIZE) break;
      }
      rebuildCompatibilityProjections?.();
      this.database.prepare(`INSERT INTO orchestration_v2_projection_metadata
        (projection_name, schema_version, last_sequence, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(projection_name) DO UPDATE SET schema_version = excluded.schema_version,
          last_sequence = excluded.last_sequence, updated_at = excluded.updated_at`)
        .run(PROJECTION_NAME, this.projectionVersion, this.latestSequence(), durableTimestamp(this.clock()));
    }).immediate();
  }

  verify(options: ProjectionVerificationOptions = {}): ProjectionVerification {
    return this.database.transaction((): ProjectionVerification => {
      const metadata = this.database.prepare(`SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata WHERE projection_name = ?`).get(PROJECTION_NAME) as
        { schema_version: number; last_sequence: number } | undefined;
      const expectedSequence = this.latestSequence();
      const missingThreadIds = (this.database.prepare(`SELECT thread_id AS id FROM orchestration_v2_events
          WHERE type = 'thread.registered'
        EXCEPT SELECT id FROM orchestration_v2_entities WHERE kind = 'thread'
        ORDER BY id LIMIT ?`).all(VERIFY_REPORT_LIMIT) as { id: string }[]).map(({ id }) => id);
      const unexpectedThreadIds = (this.database.prepare(`SELECT id FROM orchestration_v2_entities WHERE kind = 'thread'
        EXCEPT SELECT thread_id AS id FROM orchestration_v2_events WHERE type = 'thread.registered'
        ORDER BY id LIMIT ?`).all(VERIFY_REPORT_LIMIT) as { id: string }[]).map(({ id }) => id);
      const readable = options.readable === true ? this.projectionReadable : options.readable || null;
      if (options.readable === true && !readable) throw new Error("No orchestration projection reader is configured.");
      const unreadable = readable ? this.unreadableProjections(readable) : [];
      const schemaVersion = metadata?.schema_version ?? 0;
      const projectionSequence = metadata?.last_sequence ?? 0;
      return {
        valid: metadata !== undefined && schemaVersion === this.projectionVersion
          && projectionSequence === expectedSequence && missingThreadIds.length === 0
          && unexpectedThreadIds.length === 0 && unreadable.length === 0,
        schemaVersion, expectedSchemaVersion: this.projectionVersion, expectedSequence, projectionSequence,
        missingThreadIds, unexpectedThreadIds, unreadable,
      };
    })();
  }

  private latestSequence(): number {
    return (this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_v2_events")
      .get() as { sequence: number }).sequence;
  }

  private unreadableProjections(readable: ProjectionReadable): UnreadableProjection[] {
    const unreadable: UnreadableProjection[] = [];
    const page = this.database.prepare(`SELECT id, payload_json FROM orchestration_v2_entities
      WHERE kind = ? AND id > ? ORDER BY id LIMIT ?`);
    for (const kind of VERIFIED_PROJECTION_KINDS) {
      let after = "";
      while (unreadable.length < VERIFY_REPORT_LIMIT) {
        const rows = page.all(kind, after, VERIFY_PAGE_SIZE) as { id: string; payload_json: string }[];
        if (rows.length === 0) break;
        for (const row of rows) {
          if (unreadable.length >= VERIFY_REPORT_LIMIT) break;
          let accepted = false;
          try {
            accepted = readable(kind, JSON.parse(row.payload_json) as JsonValue);
          } catch {
            accepted = false;
          }
          if (!accepted) unreadable.push({ kind, id: row.id });
        }
        after = rows.at(-1)!.id;
        if (rows.length < VERIFY_PAGE_SIZE) break;
      }
    }
    return unreadable;
  }

  private receiptRow(identity: Pick<CommandIdentity, "actorId" | "commandId">): ReceiptRow | undefined {
    return this.database.prepare(`SELECT * FROM orchestration_v2_receipts
      WHERE actor_id = ? AND command_id = ?`).get(identity.actorId, identity.commandId) as ReceiptRow | undefined;
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
