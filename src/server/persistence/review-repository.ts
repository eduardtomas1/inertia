import { randomUUID } from "node:crypto";

import type {
  DiffReviewNote,
  DiffReviewState,
  DiffReviewSummary,
} from "../../shared/contracts";
import { validatePersistedReviewSummary } from "../review-summary";
import type { PersistenceContext } from "./context";
import { RecordNotFoundError } from "./errors";
import { reviewNoteFromRow } from "./review-codecs";
import type {
  DiffReviewNoteRow,
  DiffReviewStateRow,
} from "./rows";

type ReviewPersistenceContext = Pick<PersistenceContext, "database" | "requireConversation">;

export class ReviewRepository {
  constructor(private readonly context: ReviewPersistenceContext) {}

  upsertSummary(summary: DiffReviewSummary): DiffReviewSummary {
    const validated = validatePersistedReviewSummary(summary);
    this.context.requireConversation(validated.conversationId);
    const filesJson = JSON.stringify(validated.files);
    const summaryJson = JSON.stringify(validated);
    this.context.database.prepare(`
      INSERT INTO diff_review_summaries
        (conversation_id, fingerprint, provider_id, overall, files_json, generated_at, summary_json)
      VALUES
        (@conversationId, @fingerprint, @providerId, @overall, @filesJson, @generatedAt, @summaryJson)
      ON CONFLICT(conversation_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        provider_id = excluded.provider_id,
        overall = excluded.overall,
        files_json = excluded.files_json,
        generated_at = excluded.generated_at,
        summary_json = excluded.summary_json
    `).run({ ...validated, filesJson, summaryJson });
    return validated;
  }

  setState(input: Omit<DiffReviewState, "stale" | "updatedAt">): DiffReviewState {
    this.context.requireConversation(input.conversationId);
    if ((input.scope === "file" && input.hunkId !== null) || (input.scope === "hunk" && !input.hunkId)) {
      throw new Error("The review target is invalid.");
    }
    const state: DiffReviewState = {
      ...input,
      repositoryPath: input.repositoryPath ?? ".",
      stale: false,
      updatedAt: new Date().toISOString(),
    };
    this.context.database.prepare(`
      INSERT INTO diff_review_states
        (conversation_id, repository_path, scope, path, hunk_id, target_fingerprint, reviewed, stale, updated_at)
      VALUES (@conversationId, @repositoryPath, @scope, @path, @hunkId, @targetFingerprint, @reviewedValue, 0, @updatedAt)
      ON CONFLICT(conversation_id, repository_path, scope, path, hunk_id) DO UPDATE SET
        target_fingerprint = excluded.target_fingerprint,
        reviewed = excluded.reviewed,
        stale = 0,
        updated_at = excluded.updated_at
    `).run({
      ...state,
      hunkId: state.hunkId ?? "",
      reviewedValue: Number(state.reviewed),
    });
    return state;
  }

  createNote(input: Omit<DiffReviewNote, "id" | "stale" | "createdAt" | "updatedAt">): DiffReviewNote {
    this.context.requireConversation(input.conversationId);
    const now = new Date().toISOString();
    const note: DiffReviewNote = {
      ...input,
      repositoryPath: input.repositoryPath ?? ".",
      id: randomUUID(),
      body: input.body.trim(),
      lineIds: [...new Set(input.lineIds)].slice(0, 500),
      stale: false,
      createdAt: now,
      updatedAt: now,
    };
    if (!note.body || note.body.length > 8_000) throw new Error("Review notes must contain between 1 and 8,000 characters.");
    const lineIdsJson = JSON.stringify(note.lineIds);
    if (lineIdsJson.length > 65_536) throw new Error("The review note range is too large.");
    this.context.database.prepare(`
      INSERT INTO diff_review_notes
        (id, conversation_id, repository_path, path, hunk_id, line_ids_json, target_fingerprint, body, stale, created_at, updated_at)
      VALUES (@id, @conversationId, @repositoryPath, @path, @hunkId, @lineIdsJson, @targetFingerprint, @body, 0, @createdAt, @updatedAt)
    `).run({ ...note, hunkId: note.hunkId ?? "", lineIdsJson });
    return note;
  }

  updateNote(conversationId: string, noteId: string, body: string): DiffReviewNote {
    this.context.requireConversation(conversationId);
    const row = this.context.database.prepare("SELECT * FROM diff_review_notes WHERE id = ? AND conversation_id = ?")
      .get(noteId, conversationId) as DiffReviewNoteRow | undefined;
    if (!row) throw new RecordNotFoundError("Review note not found.");
    const nextBody = body.trim();
    if (!nextBody || nextBody.length > 8_000) throw new Error("Review notes must contain between 1 and 8,000 characters.");
    const updatedAt = new Date().toISOString();
    this.context.database.prepare("UPDATE diff_review_notes SET body = ?, updated_at = ? WHERE id = ?").run(nextBody, updatedAt, noteId);
    return { ...reviewNoteFromRow(row), body: nextBody, updatedAt };
  }

  deleteNote(conversationId: string, noteId: string): void {
    this.context.requireConversation(conversationId);
    const result = this.context.database.prepare("DELETE FROM diff_review_notes WHERE id = ? AND conversation_id = ?").run(noteId, conversationId);
    if (result.changes === 0) throw new RecordNotFoundError("Review note not found.");
  }

  notesFor(conversationId: string): DiffReviewNote[] {
    this.context.requireConversation(conversationId);
    return (this.context.database.prepare("SELECT * FROM diff_review_notes WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conversationId) as DiffReviewNoteRow[]).map(reviewNoteFromRow);
  }

  reconcileTargets(
    conversationId: string,
    repositoryPath: string,
    targetPath: string | undefined,
    targets: {
      files: Readonly<Record<string, string>>;
      hunks: Readonly<Record<string, string>>;
      notes: Readonly<Record<string, string | null>>;
    },
  ): boolean {
    this.context.requireConversation(conversationId);
    const stateRows = (targetPath
      ? this.context.database.prepare(
        "SELECT * FROM diff_review_states WHERE conversation_id = ? AND repository_path = ? AND path = ?",
      ).all(conversationId, repositoryPath, targetPath)
      : this.context.database.prepare(
        "SELECT * FROM diff_review_states WHERE conversation_id = ? AND repository_path = ?",
      ).all(conversationId, repositoryPath)) as DiffReviewStateRow[];
    const noteRows = (targetPath
      ? this.context.database.prepare(
        "SELECT * FROM diff_review_notes WHERE conversation_id = ? AND repository_path = ? AND path = ?",
      ).all(conversationId, repositoryPath, targetPath)
      : this.context.database.prepare(
        "SELECT * FROM diff_review_notes WHERE conversation_id = ? AND repository_path = ?",
      ).all(conversationId, repositoryPath)) as DiffReviewNoteRow[];
    const updateState = this.context.database.prepare("UPDATE diff_review_states SET reviewed = ?, stale = ?, updated_at = ? WHERE conversation_id = ? AND repository_path = ? AND scope = ? AND path = ? AND hunk_id = ?");
    const updateNote = this.context.database.prepare("UPDATE diff_review_notes SET stale = ? WHERE id = ?");
    const now = new Date().toISOString();
    let changed = false;
    this.context.database.transaction(() => {
      for (const row of stateRows) {
        const current = row.scope === "file"
          ? targets.files[row.path]
          : targets.hunks[`${row.path}\0${row.hunk_id}`];
        const stale = current !== row.target_fingerprint;
        if (stale !== (row.stale === 1) || (stale && row.reviewed === 1)) {
          changed = updateState.run(
            stale ? 0 : row.reviewed,
            Number(stale),
            now,
            row.conversation_id,
            row.repository_path,
            row.scope,
            row.path,
            row.hunk_id,
          ).changes > 0 || changed;
        }
      }
      for (const row of noteRows) {
        const current = Object.prototype.hasOwnProperty.call(targets.notes, row.id)
          ? targets.notes[row.id]
          : row.hunk_id
            ? targets.hunks[`${row.path}\0${row.hunk_id}`]
            : targets.files[row.path];
        const stale = current !== row.target_fingerprint;
        if (stale !== (row.stale === 1)) {
          changed = updateNote.run(Number(stale), row.id).changes > 0 || changed;
        }
      }
    })();
    return changed;
  }
}
