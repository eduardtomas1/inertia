import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { z } from "zod";

import {
  INITIATIVE_NOTE_CONFLICT_MESSAGE,
  initiativeNoteBodyInputSchema,
  initiativeNoteSchema,
  initiativeNoteTitleInputSchema,
  MAX_INITIATIVE_NOTES,
  MAX_REJECTED_INITIATIVE_NOTES,
  type InitiativeNote,
  type InitiativeNoteKind,
  type InitiativeNoteProvenance,
} from "../../shared/initiatives";
import { InitiativeRepositoryError } from "./initiative-repository-error";

interface InitiativeNoteRow {
  id: string;
  initiative_id: string;
  title: string;
  body: string;
  provenance: string;
  state: string;
  source_conversation_id: string | null;
  kind: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface InitiativeNoteCreateInput {
  initiativeId: string;
  title: string;
  body: string;
  /** User notes are accepted at once; agent notes always start as proposals. */
  provenance: InitiativeNoteProvenance;
  /** The chat an agent proposed the note from. Ignored for user notes. */
  sourceConversationId?: string | null;
  /** What an agent said its proposal records. Ignored for user notes. */
  kind?: InitiativeNoteKind | null;
}

export interface InitiativeNoteEdits {
  title?: string;
  body?: string;
}

export type InitiativeNoteDecision = "accept" | "reject";

const NOTE_COLUMNS = `
  id, initiative_id, title, body, provenance, state, source_conversation_id, kind,
  revision, created_at, updated_at
`;
const MISSING_NOTE = "That note no longer exists.";
const MISSING_INITIATIVE = "That initiative no longer exists.";
const NOTE_LIMIT_MESSAGE = `An initiative keeps at most ${MAX_INITIATIVE_NOTES} notes. Delete one first.`;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InitiativeRepositoryError(parsed.error.issues[0]?.message ?? "The note is invalid.");
  }
  return parsed.data;
}

function noteFromRow(row: InitiativeNoteRow): InitiativeNote | null {
  const parsed = initiativeNoteSchema.safeParse({
    id: row.id,
    initiativeId: row.initiative_id,
    title: row.title,
    body: row.body,
    provenance: row.provenance,
    state: row.state,
    sourceConversationId: row.source_conversation_id,
    kind: row.kind,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Initiative notes. Every write runs in one transaction with its effect on
 * `initiatives.notes_revision`, which moves exactly when the set or content of
 * accepted notes changes: that is what chats are sent again. Proposals and
 * rejected notes never reach an agent, so they leave it alone.
 */
export class InitiativeNoteRepository {
  private malformedRowReported = false;

  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Notes in creation order. Rejected notes are kept for their provenance but
   * listed only on request; a malformed row is skipped, never thrown.
   */
  list(initiativeId: string, { includeRejected = false }: { includeRejected?: boolean } = {}): InitiativeNote[] {
    const rows = this.database.prepare(`
      SELECT ${NOTE_COLUMNS}
      FROM initiative_notes
      WHERE initiative_id = ? ${includeRejected ? "" : "AND state <> 'rejected'"}
      ORDER BY created_at ASC, id ASC
    `).all(initiativeId) as InitiativeNoteRow[];
    const notes: InitiativeNote[] = [];
    for (const row of rows) {
      const note = noteFromRow(row);
      if (note) notes.push(note);
      else this.reportMalformedRow();
    }
    return notes;
  }

  /** Accepted notes only: the material chats receive. */
  accepted(initiativeId: string): InitiativeNote[] {
    return this.list(initiativeId).filter(({ state }) => state === "accepted");
  }

  get(noteId: string): InitiativeNote | null {
    const row = this.database.prepare(`
      SELECT ${NOTE_COLUMNS} FROM initiative_notes WHERE id = ?
    `).get(noteId) as InitiativeNoteRow | undefined;
    if (!row) return null;
    const note = noteFromRow(row);
    if (!note) this.reportMalformedRow();
    return note;
  }

  /**
   * Adds a user note, accepted at once, or an agent proposal. Proposals have
   * their own limits, which the proposal transaction enforces with readable
   * reasons; the database's triggers are the backstop here.
   */
  create(input: InitiativeNoteCreateInput): InitiativeNote {
    const title = parse(initiativeNoteTitleInputSchema, input.title);
    const body = parse(initiativeNoteBodyInputSchema, input.body);
    return this.database.transaction(() => {
      if (!this.database.prepare("SELECT 1 FROM initiatives WHERE id = ?").get(input.initiativeId)) {
        throw new InitiativeRepositoryError(MISSING_INITIATIVE);
      }
      const agent = input.provenance === "agent";
      if (!agent) this.assertRoomForAccepted(input.initiativeId);
      const timestamp = this.now();
      const note = parse(initiativeNoteSchema, {
        id: randomUUID(),
        initiativeId: input.initiativeId,
        title,
        body,
        provenance: input.provenance,
        state: agent ? "proposed" : "accepted",
        sourceConversationId: agent ? input.sourceConversationId ?? null : null,
        kind: agent ? input.kind ?? null : null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.database.prepare(`
        INSERT INTO initiative_notes (${NOTE_COLUMNS})
        VALUES (
          @id, @initiativeId, @title, @body, @provenance, @state, @sourceConversationId, @kind,
          @revision, @createdAt, @updatedAt
        )
      `).run(note);
      if (note.state === "accepted") this.bumpNotesRevision(note.initiativeId);
      return note;
    })();
  }

  /** Edits an accepted note or a proposal; an accepted note's change is sent again. */
  update(noteId: string, expectedRevision: number, edits: InitiativeNoteEdits): InitiativeNote {
    const patch = this.edits(edits);
    return this.database.transaction(() => {
      const existing = this.requireCurrent(noteId, expectedRevision);
      if (existing.state === "rejected") {
        throw new InitiativeRepositoryError("A rejected note cannot be edited.");
      }
      const changed = (patch.title !== undefined && patch.title !== existing.title)
        || (patch.body !== undefined && patch.body !== existing.body);
      if (!changed) return existing;
      const next = this.write(existing, { ...patch, state: existing.state });
      if (next.state === "accepted") this.bumpNotesRevision(next.initiativeId);
      return next;
    })();
  }

  /**
   * Accepts (optionally with edits) or rejects a proposal. Accepting adds it
   * to what chats receive, within the accepted-note limit; rejecting keeps it
   * out, with its provenance. Only the newest rejected notes are kept, so
   * rejections stay bounded.
   */
  resolve(
    noteId: string,
    expectedRevision: number,
    decision: InitiativeNoteDecision,
    edits: InitiativeNoteEdits = {},
  ): InitiativeNote {
    const patch = this.edits(edits);
    if (decision === "reject" && (patch.title !== undefined || patch.body !== undefined)) {
      throw new InitiativeRepositoryError("Only an accepted note can be edited.");
    }
    return this.database.transaction(() => {
      const existing = this.requireCurrent(noteId, expectedRevision);
      if (existing.state !== "proposed") {
        throw new InitiativeRepositoryError("That note was already reviewed.");
      }
      if (decision === "accept") this.assertRoomForAccepted(existing.initiativeId);
      const next = this.write(existing, {
        ...patch,
        state: decision === "accept" ? "accepted" : "rejected",
      });
      if (next.state === "accepted") this.bumpNotesRevision(next.initiativeId);
      else this.pruneRejected(next.initiativeId);
      return next;
    })();
  }

  delete(noteId: string): void {
    this.database.transaction(() => {
      const existing = this.get(noteId);
      if (!existing) throw new InitiativeRepositoryError(MISSING_NOTE);
      this.database.prepare("DELETE FROM initiative_notes WHERE id = ?").run(noteId);
      if (existing.state === "accepted") this.bumpNotesRevision(existing.initiativeId);
    })();
  }

  private edits(edits: InitiativeNoteEdits): InitiativeNoteEdits {
    return {
      ...(edits.title !== undefined ? { title: parse(initiativeNoteTitleInputSchema, edits.title) } : {}),
      ...(edits.body !== undefined ? { body: parse(initiativeNoteBodyInputSchema, edits.body) } : {}),
    };
  }

  private requireCurrent(noteId: string, expectedRevision: number): InitiativeNote {
    const existing = this.get(noteId);
    if (!existing) throw new InitiativeRepositoryError(MISSING_NOTE);
    if (existing.revision !== expectedRevision) {
      throw new InitiativeRepositoryError(INITIATIVE_NOTE_CONFLICT_MESSAGE);
    }
    return existing;
  }

  private write(
    existing: InitiativeNote,
    change: InitiativeNoteEdits & { state: InitiativeNote["state"] },
  ): InitiativeNote {
    const next = parse(initiativeNoteSchema, {
      ...existing,
      title: change.title ?? existing.title,
      body: change.body ?? existing.body,
      state: change.state,
      revision: existing.revision + 1,
      updatedAt: this.now(),
    });
    const result = this.database.prepare(`
      UPDATE initiative_notes SET title = ?, body = ?, state = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(next.title, next.body, next.state, next.revision, next.updatedAt, existing.id, existing.revision);
    if (result.changes !== 1) throw new InitiativeRepositoryError(INITIATIVE_NOTE_CONFLICT_MESSAGE);
    return next;
  }

  private assertRoomForAccepted(initiativeId: string): void {
    const { count } = this.database.prepare(`
      SELECT COUNT(*) AS count FROM initiative_notes
      WHERE initiative_id = ? AND state = 'accepted'
    `).get(initiativeId) as { count: number };
    if (count >= MAX_INITIATIVE_NOTES) throw new InitiativeRepositoryError(NOTE_LIMIT_MESSAGE);
  }

  /** The accepted set changed; chats receive the notes index again. */
  private bumpNotesRevision(initiativeId: string): void {
    this.database.prepare("UPDATE initiatives SET notes_revision = notes_revision + 1 WHERE id = ?")
      .run(initiativeId);
  }

  private pruneRejected(initiativeId: string): void {
    this.database.prepare(`
      DELETE FROM initiative_notes
      WHERE initiative_id = @initiativeId AND state = 'rejected'
        AND id NOT IN (
          SELECT id FROM initiative_notes
          WHERE initiative_id = @initiativeId AND state = 'rejected'
          ORDER BY updated_at DESC, id DESC
          LIMIT @keep
        )
    `).run({ initiativeId, keep: MAX_REJECTED_INITIATIVE_NOTES });
  }

  private reportMalformedRow(): void {
    if (this.malformedRowReported) return;
    this.malformedRowReported = true;
    console.warn("A malformed initiative note was omitted.");
  }
}
