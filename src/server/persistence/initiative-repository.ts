import type Database from "better-sqlite3";
import type { z } from "zod";

import {
  defaultInitiativeColor,
  initiativeAcceptsChats,
  initiativeColorSchema,
  initiativeNameInputSchema,
  initiativePatchSchema,
  initiativeSchema,
  MAX_INITIATIVES,
  type Initiative,
  type InitiativeColor,
  type InitiativePatch,
} from "../../shared/initiatives";

interface InitiativeRow {
  id: string;
  name: string;
  color: string;
  status: string;
  brief: string;
  brief_revision: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface InitiativeCreateInput {
  id: string;
  name: string;
  color?: InitiativeColor;
}

export class InitiativeRepositoryError extends Error {}

const INITIATIVE_COLUMNS = `
  id, name, color, status, brief, brief_revision, revision, created_at, updated_at
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
    brief: row.brief,
    briefRevision: row.brief_revision,
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

export class InitiativeRepository {
  private malformedRowReported = false;

  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

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
        brief: "",
        briefRevision: 0,
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

  update(initiativeId: string, expectedRevision: number, input: InitiativePatch): Initiative {
    const patch = parse(initiativePatchSchema, input);
    return this.database.transaction(() => {
      const existing = this.get(initiativeId);
      if (!existing) throw new InitiativeRepositoryError(MISSING_INITIATIVE);
      if (existing.revision !== expectedRevision) this.throwStale();
      const next = parse(initiativeSchema, {
        ...existing,
        name: patch.name ?? existing.name,
        color: patch.color ?? existing.color,
        status: patch.status ?? existing.status,
        revision: existing.revision + 1,
        updatedAt: this.now(),
      });
      const result = this.database.prepare(`
        UPDATE initiatives SET
          name = ?, color = ?, status = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        next.name,
        next.color,
        next.status,
        next.revision,
        next.updatedAt,
        initiativeId,
        expectedRevision,
      );
      if (result.changes !== 1) this.throwStale();
      return next;
    })();
  }

  /** Deletes the initiative only; member chats stay and simply lose their membership. */
  delete(initiativeId: string): void {
    this.database.transaction(() => {
      if (!this.get(initiativeId)) throw new InitiativeRepositoryError(MISSING_INITIATIVE);
      // Explicit, so membership clearing never depends on connection pragmas.
      this.database.prepare("UPDATE conversations SET initiative_id = NULL WHERE initiative_id = ?")
        .run(initiativeId);
      this.database.prepare("DELETE FROM initiatives WHERE id = ?").run(initiativeId);
    })();
  }

  /**
   * Changes only `conversations.initiative_id`. Project, workspace, worktree,
   * provider, session and chronology (`updated_at`) are deliberately untouched.
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
