import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { z } from "zod";

import {
  MAX_LIBRARY_CATEGORIES,
  MAX_LIBRARY_PAGES,
  MAX_SAVED_ANSWERS,
  libraryCategoryNameKey,
  libraryCategoryNameSchema,
  libraryCategorySchema,
  libraryPageSchema,
  savedAnswerDefaultTitle,
  savedAnswerExcerpt,
  savedAnswerPatchSchema,
  savedAnswerSchema,
  savedAnswerTitleSchema,
  type LibraryCategory,
  type LibraryPage,
  type LibrarySnapshot,
  type SavedAnswer,
  type SavedAnswerPatch,
} from "../../shared/library";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { AgentTurnStatus } from "../../shared/contracts";
import { readBoundedMessageText } from "./bounded-message-text";

export const LIBRARY_CATEGORY_LIMIT_MESSAGE =
  `You have ${MAX_LIBRARY_CATEGORIES} categories. Delete one first.`;
export const LIBRARY_CATEGORY_DUPLICATE_MESSAGE = "A category with that name already exists.";
export const LIBRARY_CATEGORY_MISSING_MESSAGE = "That category no longer exists.";
export const SAVED_ANSWER_LIMIT_MESSAGE =
  `You have ${MAX_SAVED_ANSWERS.toLocaleString("en-US")} saved answers. Remove some first.`;
export const SAVED_ANSWER_MISSING_MESSAGE = "That saved answer no longer exists.";
export const SAVED_ANSWER_SOURCE_MISSING_MESSAGE = "That answer no longer exists.";
export const SAVED_ANSWER_UNSETTLED_MESSAGE = "Wait for the answer to finish before saving it.";
export const SAVED_ANSWER_NOT_FINAL_MESSAGE = "Only a turn's final answer can be saved.";

const SOURCE_TEXT_BYTES = 16 * 1_024;

export class LibraryRepositoryError extends Error {}

export interface SaveAnswerInput {
  conversationId: string;
  turnId: string;
  messageId: string;
  categoryId: string | null;
  title?: string;
}

interface CategoryRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface SavedAnswerRow {
  id: string;
  conversation_id: string;
  project_id: string;
  turn_id: string;
  message_id: string;
  category_id: string | null;
  title: string;
  excerpt: string;
  created_at: string;
  updated_at: string;
}

interface PageRow {
  id: string;
  title: string;
  conversation_id: string;
  conversation_title: string;
  project_id: string;
  turn_id: string;
  created_at: string;
  archived_at: string | null;
  message_id: string | null;
  html_render_json: string | null;
}

const SAVED_ANSWER_SELECT = `
  SELECT saved_answers.id, saved_answers.conversation_id, conversations.project_id,
    saved_answers.turn_id, saved_answers.message_id, saved_answers.category_id,
    saved_answers.title, saved_answers.excerpt, saved_answers.created_at, saved_answers.updated_at
  FROM saved_answers
  CROSS JOIN conversations ON conversations.id = saved_answers.conversation_id
`;

function parse<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LibraryRepositoryError(parsed.error.issues[0]?.message ?? fallback);
  return parsed.data;
}

function categoryFromRow(row: CategoryRow): LibraryCategory | null {
  const parsed = libraryCategorySchema.safeParse({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

function savedAnswerFromRow(row: SavedAnswerRow): SavedAnswer | null {
  const parsed = savedAnswerSchema.safeParse({
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    turnId: row.turn_id,
    messageId: row.message_id,
    categoryId: row.category_id,
    title: row.title,
    excerpt: row.excerpt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

function renderHeight(json: string | null): number | null {
  if (!json) return null;
  try {
    const height = (JSON.parse(json) as { height?: unknown }).height;
    return typeof height === "number" && Number.isInteger(height) && height > 0 ? height : null;
  } catch {
    return null;
  }
}

function pageFromRow(row: PageRow): LibraryPage | null {
  const parsed = libraryPageSchema.safeParse({
    renderId: row.id,
    title: row.title,
    height: renderHeight(row.html_render_json),
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    projectId: row.project_id,
    turnId: row.turn_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    archived: row.archived_at !== null,
  });
  return parsed.success ? parsed.data : null;
}

export class LibraryRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  snapshot(): LibrarySnapshot {
    return { categories: this.categories(), savedAnswers: this.savedAnswers() };
  }

  categories(): LibraryCategory[] {
    return (this.database.prepare(`
      SELECT id, name, created_at, updated_at FROM library_categories
      ORDER BY name COLLATE NOCASE ASC, id ASC
      LIMIT ?
    `).all(MAX_LIBRARY_CATEGORIES) as CategoryRow[]).flatMap((row) => categoryFromRow(row) ?? []);
  }

  savedAnswers(): SavedAnswer[] {
    return (this.database.prepare(`
      ${SAVED_ANSWER_SELECT}
      ORDER BY saved_answers.created_at DESC, saved_answers.id DESC
      LIMIT ?
    `).all(MAX_SAVED_ANSWERS) as SavedAnswerRow[]).flatMap((row) => savedAnswerFromRow(row) ?? []);
  }

  savedAnswer(savedAnswerId: string): SavedAnswer | null {
    const row = this.database.prepare(`${SAVED_ANSWER_SELECT} WHERE saved_answers.id = ?`)
      .get(savedAnswerId) as SavedAnswerRow | undefined;
    return row ? savedAnswerFromRow(row) : null;
  }

  createCategory(name: string): LibraryCategory {
    const trimmed = parse(libraryCategoryNameSchema, name, "The category name is invalid.");
    return this.database.transaction(() => {
      const count = (this.database.prepare("SELECT COUNT(*) AS count FROM library_categories")
        .get() as { count: number }).count;
      if (count >= MAX_LIBRARY_CATEGORIES) throw new LibraryRepositoryError(LIBRARY_CATEGORY_LIMIT_MESSAGE);
      this.assertUniqueName(trimmed, null);
      const timestamp = this.now();
      const category = parse(libraryCategorySchema, {
        id: this.createId(),
        name: trimmed,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, "The category is invalid.");
      this.database.prepare(`
        INSERT INTO library_categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
      `).run(category.id, category.name, category.createdAt, category.updatedAt);
      return category;
    })();
  }

  renameCategory(categoryId: string, name: string): LibraryCategory {
    const trimmed = parse(libraryCategoryNameSchema, name, "The category name is invalid.");
    return this.database.transaction(() => {
      const existing = this.requireCategory(categoryId);
      if (existing.name === trimmed) return existing;
      this.assertUniqueName(trimmed, categoryId);
      const renamed = { ...existing, name: trimmed, updatedAt: this.now() };
      this.database.prepare("UPDATE library_categories SET name = ?, updated_at = ? WHERE id = ?")
        .run(renamed.name, renamed.updatedAt, renamed.id);
      return renamed;
    })();
  }

  deleteCategory(categoryId: string): void {
    if (this.database.prepare("DELETE FROM library_categories WHERE id = ?").run(categoryId).changes === 0) {
      throw new LibraryRepositoryError(LIBRARY_CATEGORY_MISSING_MESSAGE);
    }
  }

  saveAnswer(input: SaveAnswerInput): SavedAnswer {
    const title = input.title === undefined
      ? undefined
      : parse(savedAnswerTitleSchema, input.title, "The title is invalid.");
    return this.database.transaction(() => {
      const turn = this.database.prepare(`
        SELECT conversation_id, user_message_id, terminal_assistant_message_id, status
        FROM agent_turns WHERE id = ?
      `).get(input.turnId) as {
        conversation_id: string;
        user_message_id: string;
        terminal_assistant_message_id: string | null;
        status: AgentTurnStatus;
      } | undefined;
      if (!turn || turn.conversation_id !== input.conversationId) {
        throw new LibraryRepositoryError(SAVED_ANSWER_SOURCE_MISSING_MESSAGE);
      }
      const message = this.database.prepare(`
        SELECT conversation_id, turn_id, role FROM messages WHERE id = ?
      `).get(input.messageId) as { conversation_id: string; turn_id: string | null; role: string } | undefined;
      if (!message || message.conversation_id !== input.conversationId) {
        throw new LibraryRepositoryError(SAVED_ANSWER_SOURCE_MISSING_MESSAGE);
      }
      if (!isAgentTurnTerminalStatus(turn.status)) {
        throw new LibraryRepositoryError(SAVED_ANSWER_UNSETTLED_MESSAGE);
      }
      if (
        message.role !== "assistant"
        || message.turn_id !== input.turnId
        || turn.terminal_assistant_message_id !== input.messageId
      ) throw new LibraryRepositoryError(SAVED_ANSWER_NOT_FINAL_MESSAGE);
      if (input.categoryId !== null) this.requireCategory(input.categoryId);
      const existing = this.database.prepare("SELECT id FROM saved_answers WHERE message_id = ?")
        .get(input.messageId) as { id: string } | undefined;
      if (existing) {
        this.database.prepare(`
          UPDATE saved_answers SET category_id = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?
        `).run(input.categoryId, title ?? null, this.now(), existing.id);
        return this.requireSavedAnswer(existing.id);
      }
      const count = (this.database.prepare("SELECT COUNT(*) AS count FROM saved_answers")
        .get() as { count: number }).count;
      if (count >= MAX_SAVED_ANSWERS) throw new LibraryRepositoryError(SAVED_ANSWER_LIMIT_MESSAGE);
      const answer = this.messageText(input.messageId);
      const timestamp = this.now();
      const id = this.createId();
      this.database.prepare(`
        INSERT INTO saved_answers (
          id, conversation_id, turn_id, message_id, category_id, title, excerpt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.conversationId,
        input.turnId,
        input.messageId,
        input.categoryId,
        title ?? savedAnswerDefaultTitle(this.messageText(turn.user_message_id), answer),
        savedAnswerExcerpt(answer),
        timestamp,
        timestamp,
      );
      return this.requireSavedAnswer(id);
    })();
  }

  updateAnswer(savedAnswerId: string, input: SavedAnswerPatch): SavedAnswer {
    const patch = parse(savedAnswerPatchSchema, input, "The saved answer update is invalid.");
    return this.database.transaction(() => {
      const existing = this.requireSavedAnswer(savedAnswerId);
      if (patch.categoryId !== undefined && patch.categoryId !== null) this.requireCategory(patch.categoryId);
      const categoryId = patch.categoryId === undefined ? existing.categoryId : patch.categoryId;
      const title = patch.title ?? existing.title;
      if (categoryId === existing.categoryId && title === existing.title) return existing;
      this.database.prepare("UPDATE saved_answers SET category_id = ?, title = ?, updated_at = ? WHERE id = ?")
        .run(categoryId, title, this.now(), savedAnswerId);
      return this.requireSavedAnswer(savedAnswerId);
    })();
  }

  removeAnswer(savedAnswerId: string): void {
    if (this.database.prepare("DELETE FROM saved_answers WHERE id = ?").run(savedAnswerId).changes === 0) {
      throw new LibraryRepositoryError(SAVED_ANSWER_MISSING_MESSAGE);
    }
  }

  pages(): LibraryPage[] {
    return (this.database.prepare(`
      SELECT html_renders.id, html_renders.title, html_renders.conversation_id,
        conversations.title AS conversation_title, conversations.project_id,
        html_renders.turn_id, html_renders.created_at, conversations.archived_at,
        messages.id AS message_id, messages.html_render_json
      FROM html_renders
      CROSS JOIN conversations ON conversations.id = html_renders.conversation_id
      LEFT JOIN messages ON messages.id = (
        SELECT candidate.id FROM messages AS candidate
        WHERE candidate.turn_id = html_renders.turn_id
          AND candidate.html_render_json IS NOT NULL
          AND json_extract(candidate.html_render_json, '$.renderId') = html_renders.id
        ORDER BY candidate.created_at ASC, candidate.id ASC
        LIMIT 1
      )
      ORDER BY html_renders.created_at DESC, html_renders.id DESC
      LIMIT ?
    `).all(MAX_LIBRARY_PAGES) as PageRow[]).flatMap((row) => pageFromRow(row) ?? []);
  }

  private assertUniqueName(name: string, exceptId: string | null): void {
    const key = libraryCategoryNameKey(name);
    const rows = this.database.prepare("SELECT id, name FROM library_categories").all() as Array<{ id: string; name: string }>;
    if (rows.some((row) => row.id !== exceptId && libraryCategoryNameKey(row.name) === key)) {
      throw new LibraryRepositoryError(LIBRARY_CATEGORY_DUPLICATE_MESSAGE);
    }
  }

  private requireCategory(categoryId: string): LibraryCategory {
    const row = this.database.prepare("SELECT id, name, created_at, updated_at FROM library_categories WHERE id = ?")
      .get(categoryId) as CategoryRow | undefined;
    const category = row ? categoryFromRow(row) : null;
    if (!category) throw new LibraryRepositoryError(LIBRARY_CATEGORY_MISSING_MESSAGE);
    return category;
  }

  private requireSavedAnswer(savedAnswerId: string): SavedAnswer {
    const answer = this.savedAnswer(savedAnswerId);
    if (!answer) throw new LibraryRepositoryError(SAVED_ANSWER_MISSING_MESSAGE);
    return answer;
  }

  private messageText(messageId: string): string {
    const row = this.database.prepare(`
      SELECT COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content
      FROM messages WHERE id = ?
    `).get(SOURCE_TEXT_BYTES + 1, messageId) as { content: Buffer } | undefined;
    if (!row) return "";
    const chunks = this.database.prepare(`
      SELECT substr(CAST(content AS BLOB), 1, ?) AS content
      FROM message_content_chunks WHERE message_id = ? ORDER BY sequence LIMIT ?
    `);
    return readBoundedMessageText(
      row.content,
      () => chunks.iterate(SOURCE_TEXT_BYTES + 1, messageId, SOURCE_TEXT_BYTES + 1) as Iterable<{ content: Buffer }>,
      SOURCE_TEXT_BYTES,
    ).content;
  }
}
