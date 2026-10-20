import type Database from "better-sqlite3";
import type { z } from "zod";

import type { AccessMode } from "../../shared/contracts";
import {
  accessModesAboveCeiling,
  applyInitiativePreferencesPatch,
  defaultInitiativeColor,
  defaultInitiativePreferences,
  exceedsAccessCeiling,
  INITIATIVE_BRIEF_CONFLICT_MESSAGE,
  initiativeAcceptsChats,
  initiativeAccessCeilingMessage,
  initiativeBriefSchema,
  initiativeColorSchema,
  initiativeNameInputSchema,
  initiativePatchSchema,
  initiativeSchema,
  MAX_INITIATIVES,
  parseInitiativePreferences,
  type Initiative,
  type InitiativeColor,
  type InitiativePatch,
  type InitiativePreferences,
} from "../../shared/initiatives";
import { InitiativeContextDeliveryRepository } from "./initiative-context-delivery-repository";
import { initiativeMemberChats, type InitiativeMemberChat } from "./initiative-member-chats";
import { InitiativeNoteRepository } from "./initiative-note-repository";
import { InitiativeRepositoryError } from "./initiative-repository-error";
import { lowerQueuedMessageAccess } from "./queued-message-repository";

interface InitiativeRow {
  id: string;
  name: string;
  color: string;
  status: string;
  preferences_json: string;
  brief: string;
  brief_revision: number;
  brief_updated_at: string | null;
  notes_revision: number;
  proposed_note_count: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface InitiativeCreateInput {
  id: string;
  name: string;
  color?: InitiativeColor;
}

export { InitiativeRepositoryError };

const INITIATIVE_COLUMNS = `
  initiatives.id, initiatives.name, initiatives.color, initiatives.status,
  initiatives.preferences_json, initiatives.brief, initiatives.brief_revision, initiatives.brief_updated_at,
  initiatives.notes_revision, initiatives.revision,
  initiatives.created_at, initiatives.updated_at,
  (
    SELECT COUNT(*) FROM initiative_notes
    WHERE initiative_notes.initiative_id = initiatives.id
      AND initiative_notes.state = 'proposed'
  ) AS proposed_note_count
`;
const MISSING_INITIATIVE = "That initiative no longer exists.";
const INACTIVE_INITIATIVE = "Only active initiatives can take chats. Reopen the initiative first.";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InitiativeRepositoryError(parsed.error.issues[0]?.message ?? "The initiative is invalid.");
  }
  return parsed.data;
}

function initiativeFromRow(row: InitiativeRow): Initiative | null {
  const parsed = initiativeSchema.safeParse({
    id: row.id,
    name: row.name,
    color: row.color,
    status: row.status,
    // Damaged preferences fall back field by field; they never hide the initiative.
    preferences: parseInitiativePreferences(row.preferences_json),
    brief: row.brief,
    briefRevision: row.brief_revision,
    briefUpdatedAt: row.brief_updated_at,
    notesRevision: row.notes_revision,
    proposedNoteCount: row.proposed_note_count,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Admission rule shared by every path that writes `conversations.initiative_id`
 * for a new or existing chat: the initiative must exist and be active. Callers
 * run it inside the same transaction as the write.
 */
export function requireInitiativeAcceptingChats(
  database: Database.Database,
  initiativeId: string,
): void {
  const row = database.prepare("SELECT status FROM initiatives WHERE id = ?")
    .get(initiativeId) as Pick<InitiativeRow, "status"> | undefined;
  if (!row) throw new InitiativeRepositoryError(MISSING_INITIATIVE);
  if (!initiativeAcceptsChats({ status: row.status as Initiative["status"] })) {
    throw new InitiativeRepositoryError(INACTIVE_INITIATIVE);
  }
}

/**
 * The access ceiling of a chat's initiative, read in the caller's transaction,
 * or null when the initiative sets none or does not exist. The ceiling holds
 * whatever the initiative's status: grouping never widens permissions.
 */
export function initiativeAccessCeiling(
  database: Database.Database,
  initiativeId: string | null | undefined,
): { ceiling: AccessMode; name: string } | null {
  if (!initiativeId) return null;
  const row = database.prepare("SELECT name, preferences_json FROM initiatives WHERE id = ?")
    .get(initiativeId) as Pick<InitiativeRow, "name" | "preferences_json"> | undefined;
  const ceiling = row ? parseInitiativePreferences(row.preferences_json).accessCeiling : null;
  return row && ceiling ? { ceiling, name: row.name } : null;
}

/**
 * Lowers the chats that exceed `ceiling` (every member of an initiative, or one
 * chat) to it, in one statement inside the caller's transaction, together with
 * the access their pending queued messages were queued with. Chronology
 * (`updated_at`) and everything else about the chats stay untouched. Returns
 * whether any chat was lowered.
 */
function lowerAccessToCeiling(
  database: Database.Database,
  ceiling: AccessMode,
  scope: { initiativeId: string } | { conversationId: string },
): boolean {
  const above = accessModesAboveCeiling(ceiling);
  if (above.length === 0) return false;
  const [column, value] = "initiativeId" in scope
    ? ["initiative_id", scope.initiativeId]
    : ["id", scope.conversationId];
  const lowered = database.prepare(`
    UPDATE conversations SET access_mode = ?
    WHERE ${column} = ? AND access_mode IN (${above.map(() => "?").join(", ")})
  `).run(ceiling, value, ...above).changes > 0;
  lowerQueuedMessageAccess(database, ceiling, scope);
  return lowered;
}

/**
 * Enforces a chat's initiative access limit when one of its turns is persisted,
 * inside that transaction. The turn itself must already run at or below the
 * limit. A chat whose stored access is above it (restored data, or a write that
 * raced the limit) is lowered to it with its queued messages; returns true when
 * that happened so the caller can publish the chat.
 */
export function enforceInitiativeAccessLimitForTurn(
  database: Database.Database,
  conversationId: string,
  turnAccess: AccessMode,
): boolean {
  const row = database.prepare("SELECT initiative_id FROM conversations WHERE id = ?")
    .get(conversationId) as { initiative_id: string | null } | undefined;
  const limit = initiativeAccessCeiling(database, row?.initiative_id);
  if (!limit) return false;
  if (exceedsAccessCeiling(turnAccess, limit.ceiling)) {
    throw new InitiativeRepositoryError(initiativeAccessCeilingMessage(limit.name, limit.ceiling));
  }
  return lowerAccessToCeiling(database, limit.ceiling, { conversationId });
}

export class InitiativeRepository {
  private malformedRowReported = false;
  /** Notes curated on the Initiative page, and agent proposals waiting for review. */
  readonly notes: InitiativeNoteRepository;
  /** What each chat last received of the brief and notes index. */
  readonly deliveries: InitiativeContextDeliveryRepository;

  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.notes = new InitiativeNoteRepository(database, now);
    this.deliveries = new InitiativeContextDeliveryRepository(database);
  }

  /**
   * Every valid initiative. A row that the database accepted but the shared
   * contract rejects is skipped, so one damaged row never breaks the snapshot;
   * chats that reference it are projected without membership.
   */
  list(): Initiative[] {
    const initiatives: Initiative[] = [];
    for (const row of this.database.prepare(`
      SELECT ${INITIATIVE_COLUMNS}
      FROM initiatives
      ORDER BY created_at ASC, id ASC
    `).all() as InitiativeRow[]) {
      const initiative = initiativeFromRow(row);
      if (initiative) initiatives.push(initiative);
      else this.reportMalformedRow();
    }
    return initiatives;
  }

  /** A malformed row reads as missing, exactly as `list()` omits it. */
  get(initiativeId: string): Initiative | null {
    const row = this.database.prepare(`
      SELECT ${INITIATIVE_COLUMNS}
      FROM initiatives
      WHERE id = ?
    `).get(initiativeId) as InitiativeRow | undefined;
    if (!row) return null;
    const initiative = initiativeFromRow(row);
    if (!initiative) this.reportMalformedRow();
    return initiative;
  }

  /**
   * The tool settings of a chat's initiative (or of the initiative a new chat
   * is created in), or null outside an initiative or when it no longer exists.
   * `RuntimeStore.initiativePreferencesFor` is the shared entry point.
   */
  preferencesFor(initiativeId: string | null | undefined): InitiativePreferences | null {
    return initiativeId ? this.get(initiativeId)?.preferences ?? null : null;
  }

  /** Creates an active initiative and, optionally, moves one chat into it atomically. */
  create(input: InitiativeCreateInput, assignConversationId?: string): Initiative {
    const name = parse(initiativeNameInputSchema, input.name);
    const requestedColor = input.color === undefined
      ? undefined
      : parse(initiativeColorSchema, input.color);
    return this.database.transaction(() => {
      const count = (this.database.prepare("SELECT COUNT(*) AS count FROM initiatives").get() as {
        count: number;
      }).count;
      if (count >= MAX_INITIATIVES) {
        throw new InitiativeRepositoryError(`Initiatives are limited to ${MAX_INITIATIVES}.`);
      }
      if (this.get(input.id)) throw new InitiativeRepositoryError("That initiative already exists.");
      const timestamp = this.now();
      const initiative = parse(initiativeSchema, {
        id: input.id,
        name,
        color: requestedColor ?? defaultInitiativeColor(count),
        status: "active",
        preferences: defaultInitiativePreferences(),
        brief: "",
        briefRevision: 0,
        briefUpdatedAt: null,
        notesRevision: 0,
        proposedNoteCount: 0,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.database.prepare(`
        INSERT INTO initiatives (
          id, name, color, status, brief, brief_revision, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', '', 0, ?, ?, ?)
      `).run(
        initiative.id,
        initiative.name,
        initiative.color,
        initiative.revision,
        initiative.createdAt,
        initiative.updatedAt,
      );
      if (assignConversationId !== undefined) {
        this.writeMembership(assignConversationId, initiative.id);
      }
      return initiative;
    })();
  }

  /**
   * Applies a rename, colour, status or settings change. Settings patches merge
   * over the stored settings. Setting or lowering the access ceiling lowers
   * every member chat above it, and the access its queued messages carry, in
   * the same transaction. A turn already running keeps the access it started
   * with until it ends; the chat's next turn starts at or below the ceiling.
   */
  update(initiativeId: string, expectedRevision: number, input: InitiativePatch): Initiative {
    const patch = parse(initiativePatchSchema, input);
    return this.database.transaction(() => {
      const existing = this.get(initiativeId);
      if (!existing) throw new InitiativeRepositoryError(MISSING_INITIATIVE);
      if (existing.revision !== expectedRevision) this.throwStale();
      const preferences = patch.preferences
        ? applyInitiativePreferencesPatch(existing.preferences, patch.preferences)
        : existing.preferences;
      if (
        patch.preferences?.defaultProjectId
        && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(patch.preferences.defaultProjectId)
      ) {
        throw new InitiativeRepositoryError("That project is no longer available.");
      }
      const next = parse(initiativeSchema, {
        ...existing,
        name: patch.name ?? existing.name,
        color: patch.color ?? existing.color,
        status: patch.status ?? existing.status,
        preferences,
        revision: existing.revision + 1,
        updatedAt: this.now(),
      });
      const result = this.database.prepare(`
        UPDATE initiatives SET
          name = ?, color = ?, status = ?, preferences_json = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        next.name,
        next.color,
        next.status,
        JSON.stringify(next.preferences),
        next.revision,
        next.updatedAt,
        initiativeId,
        expectedRevision,
      );
      if (result.changes !== 1) this.throwStale();
      if (next.preferences.accessCeiling) {
        lowerAccessToCeiling(this.database, next.preferences.accessCeiling, { initiativeId });
      }
      return next;
    })();
  }

  /**
   * Replaces the brief when the caller saw the current brief revision. A real
   * change moves both the brief revision (which chats are sent again) and the
   * row revision (which guards renames, colours and status). Saving the same
   * text is a no-op, so it never re-sends an unchanged brief.
   */
  updateBrief(initiativeId: string, expectedBriefRevision: number, brief: string): Initiative {
    const text = parse(initiativeBriefSchema, brief);
    return this.database.transaction(() => {
      const existing = this.get(initiativeId);
      if (!existing) throw new InitiativeRepositoryError(MISSING_INITIATIVE);
      if (existing.briefRevision !== expectedBriefRevision) {
        throw new InitiativeRepositoryError(INITIATIVE_BRIEF_CONFLICT_MESSAGE);
      }
      if (existing.brief === text) return existing;
      const timestamp = this.now();
      const next = parse(initiativeSchema, {
        ...existing,
        brief: text,
        briefRevision: existing.briefRevision + 1,
        briefUpdatedAt: timestamp,
        revision: existing.revision + 1,
        updatedAt: timestamp,
      });
      const result = this.database.prepare(`
        UPDATE initiatives SET
          brief = ?, brief_revision = ?, brief_updated_at = ?, revision = ?, updated_at = ?
        WHERE id = ? AND brief_revision = ?
      `).run(
        next.brief,
        next.briefRevision,
        next.briefUpdatedAt,
        next.revision,
        next.updatedAt,
        initiativeId,
        expectedBriefRevision,
      );
      if (result.changes !== 1) throw new InitiativeRepositoryError(INITIATIVE_BRIEF_CONFLICT_MESSAGE);
      return next;
    })();
  }

  /**
   * Deletes the initiative with its notes; member chats stay and simply lose
   * their membership. Delivery records keep the name their sessions were told,
   * so the next turn of each such session says the initiative no longer applies.
   */
  delete(initiativeId: string): void {
    this.database.transaction(() => {
      if (!this.get(initiativeId)) throw new InitiativeRepositoryError(MISSING_INITIATIVE);
      // Explicit, so membership clearing never depends on connection pragmas.
      this.database.prepare("UPDATE conversations SET initiative_id = NULL WHERE initiative_id = ?")
        .run(initiativeId);
      this.database.prepare("DELETE FROM initiative_notes WHERE initiative_id = ?").run(initiativeId);
      this.database.prepare("UPDATE initiative_context_deliveries SET initiative_id = NULL WHERE initiative_id = ?")
        .run(initiativeId);
      this.database.prepare("DELETE FROM initiatives WHERE id = ?").run(initiativeId);
    })();
  }

  /** See `initiativeMemberChats`: the chats an initiative's agents are shown. */
  memberChats(initiativeId: string, options: { first: string | null; limit: number }): {
    chats: InitiativeMemberChat[];
    total: number;
  } {
    return initiativeMemberChats(this.database, initiativeId, options);
  }

  /**
   * Changes `conversations.initiative_id`, and lowers the chat's access mode
   * (and its queued messages') to the initiative's ceiling when it exceeds it.
   * Project, workspace, worktree, provider, session and chronology
   * (`updated_at`) are deliberately untouched.
   */
  assignConversation(conversationId: string, initiativeId: string | null): void {
    this.database.transaction(() => {
      this.writeMembership(conversationId, initiativeId);
    })();
  }

  /**
   * The one admission check for paths that put a new chat in an initiative:
   * managed-child inheritance, new-chat creation and Duo launches. True when
   * the initiative exists and is active. With `require`, a refusal throws its
   * renderer-safe reason instead of returning false. Inserts still re-check
   * atomically, so this only lets callers decide before doing any work.
   */
  acceptsChats(initiativeId: string, { require = false }: { require?: boolean } = {}): boolean {
    try {
      requireInitiativeAcceptingChats(this.database, initiativeId);
      return true;
    } catch (error) {
      if (!require && error instanceof InitiativeRepositoryError) return false;
      throw error;
    }
  }

  private writeMembership(conversationId: string, initiativeId: string | null): void {
    const conversation = this.database.prepare("SELECT initiative_id FROM conversations WHERE id = ?")
      .get(conversationId) as { initiative_id: string | null } | undefined;
    if (!conversation) throw new InitiativeRepositoryError("That chat no longer exists.");
    if (conversation.initiative_id === initiativeId) return;
    if (initiativeId !== null) requireInitiativeAcceptingChats(this.database, initiativeId);
    this.database.prepare("UPDATE conversations SET initiative_id = ? WHERE id = ?")
      .run(initiativeId, conversationId);
    const ceiling = initiativeAccessCeiling(this.database, initiativeId)?.ceiling;
    if (ceiling) lowerAccessToCeiling(this.database, ceiling, { conversationId });
  }

  private reportMalformedRow(): void {
    if (this.malformedRowReported) return;
    this.malformedRowReported = true;
    console.warn("A malformed initiative was omitted from the runtime snapshot.");
  }

  private throwStale(): never {
    throw new InitiativeRepositoryError(
      "The initiative changed elsewhere. Review the latest version and try again.",
    );
  }
}
