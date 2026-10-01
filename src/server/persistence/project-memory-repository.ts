import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ClientCommand } from "../../shared/contracts/client-command";
import {
  MAX_PROJECT_MEMORY_CONTEXT_BYTES,
  PROJECT_MEMORY_CONTEXT_LABEL,
  projectMemoryContext,
  projectMemoryDraftSchema,
  projectMemoryEntriesSchema,
  type ProjectMemoryEntry,
  type ProjectMemorySourcePreview,
  type ProjectMemoryState,
} from "../../shared/project-memory";

type Payload<T extends ClientCommand["type"]> = Extract<ClientCommand, { type: T }> extends { payload: infer P } ? P : never;
type Scope = Payload<"project.memory.load">;

export class ProjectMemoryError extends Error {}

/** User-authored memory stays project-scoped; sources are immutable provenance. */
export class ProjectMemoryRepository {
  constructor(private readonly database: Database.Database) {}

  private assertScope({ projectId, conversationId }: Scope): void {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ProjectMemoryError("This project is no longer available.");
    }
    if (conversationId && !this.database.prepare(
      "SELECT 1 FROM conversations WHERE id = ? AND project_id = ?",
    ).get(conversationId, projectId)) {
      throw new ProjectMemoryError("This chat does not belong to the selected project.");
    }
  }

  load(scope: Scope): ProjectMemoryState {
    this.assertScope(scope);
    const row = this.database.prepare(
      "SELECT revision, entries_json FROM project_memory WHERE project_id = ?",
    ).get(scope.projectId) as { revision: number; entries_json: string } | undefined;
    const entries = projectMemoryEntriesSchema.parse(row ? JSON.parse(row.entries_json) : []);
    const chat = scope.conversationId ? this.database.prepare(
      "SELECT revision, disabled_ids_json FROM conversation_project_memory WHERE conversation_id = ?",
    ).get(scope.conversationId) as { revision: number; disabled_ids_json: string } | undefined : undefined;
    const disabled = new Set<string>(chat ? JSON.parse(chat.disabled_ids_json) : []);
    const state = {
      projectId: scope.projectId,
      conversationId: scope.conversationId ?? null,
      revision: row?.revision ?? 0,
      chatRevision: chat?.revision ?? 0,
      entries,
      disabledIds: entries.filter(({ id }) => disabled.has(id)).map(({ id }) => id),
      unavailableSourceIds: entries.filter(({ source }) => source && !this.database.prepare(`
        SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = ? AND c.id = ? AND c.project_id = ?
      `).get(source.messageId, source.conversationId, scope.projectId)).map(({ id }) => id),
    };
    return { ...state, context: projectMemoryContext(state) };
  }

  private current(scope: Scope & { expectedRevision: number }): ProjectMemoryState {
    const state = this.load(scope);
    if (state.revision !== scope.expectedRevision) {
      throw new ProjectMemoryError("Project memory changed in another window. Refresh and review your draft before saving again.");
    }
    return state;
  }

  private persist(state: ProjectMemoryState, entries: ProjectMemoryEntry[]): void {
    const parsed = projectMemoryEntriesSchema.safeParse(entries);
    if (!parsed.success) throw new ProjectMemoryError("Project memory is full. Keep up to 20 concise entries within 24 KiB.");
    this.database.prepare(`
      INSERT INTO project_memory (project_id, revision, entries_json) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, entries_json = excluded.entries_json
    `).run(state.projectId, state.revision + 1, JSON.stringify(parsed.data));
  }

  save(input: Payload<"project.memory.save">): ProjectMemoryState {
    return this.database.transaction(() => {
      const state = this.current(input);
      const current = state.entries.find(({ id }) => id === input.id);
      const draft = projectMemoryDraftSchema.safeParse(input.entry);
      if (!draft.success) throw new ProjectMemoryError("Enter a title, a concise rule or decision, and its reason.");
      if (input.mode === "update" && !current) throw new ProjectMemoryError("This entry was deleted. Your draft has not been saved.");
      if (input.mode === "create" && current) throw new ProjectMemoryError("This entry already exists. Refresh to see the saved version.");
      if (current && input.source) throw new ProjectMemoryError("An entry's source cannot be replaced.");
      let source = current?.source ?? null;
      if (input.source) {
        const row = this.database.prepare(`
          SELECT c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = ? AND c.id = ? AND c.project_id = ? AND m.role IN ('user', 'assistant')
        `).get(input.source.messageId, input.source.conversationId, input.projectId) as { title: string } | undefined;
        if (!row) throw new ProjectMemoryError("The source message is no longer available in this project.");
        source = { ...input.source, conversationTitle: row.title.slice(0, 120).trim() || "Source chat" };
      }
      const now = new Date().toISOString();
      const entry: ProjectMemoryEntry = {
        ...draft.data, id: input.id, source, createdAt: current?.createdAt ?? now, updatedAt: now,
      };
      this.persist(state, current
        ? state.entries.map((item) => item.id === entry.id ? entry : item)
        : [...state.entries, entry]);
      return this.load(input);
    })();
  }

  remove(input: Payload<"project.memory.delete">): ProjectMemoryState {
    return this.database.transaction(() => {
      const state = this.current(input);
      if (!state.entries.some(({ id }) => id === input.id)) throw new ProjectMemoryError("This entry no longer exists.");
      this.persist(state, state.entries.filter(({ id }) => id !== input.id));
      return this.load(input);
    })();
  }

  toggle(input: Payload<"project.memory.toggle">): ProjectMemoryState {
    return this.database.transaction(() => {
      const state = this.current(input);
      if (state.chatRevision !== input.expectedChatRevision) {
        throw new ProjectMemoryError("This chat's memory selection changed in another window. Refresh before changing it.");
      }
      if (!state.entries.some(({ id }) => id === input.id)) throw new ProjectMemoryError("This entry no longer exists.");
      const disabled = new Set(state.disabledIds);
      if (input.enabled) disabled.delete(input.id);
      else disabled.add(input.id);
      this.database.prepare(`
        INSERT INTO conversation_project_memory (conversation_id, revision, disabled_ids_json) VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET revision = excluded.revision, disabled_ids_json = excluded.disabled_ids_json
      `).run(input.conversationId, state.chatRevision + 1, JSON.stringify([...disabled]));
      return this.load(input);
    })();
  }

  contextForConversation(conversationId: string): string | null {
    const row = this.database.prepare("SELECT project_id FROM conversations WHERE id = ?").get(conversationId) as { project_id: string } | undefined;
    if (!row) throw new ProjectMemoryError("This chat is no longer available.");
    return this.load({ projectId: row.project_id, conversationId }).context;
  }

  sourcePreview(input: Payload<"project.memory.source">): ProjectMemorySourcePreview {
    const entry = this.load(input).entries.find(({ id }) => id === input.id);
    if (!entry?.source) throw new ProjectMemoryError("This entry has no source message.");
    const row = this.database.prepare(`
      SELECT substr(m.content, 1, 4001) AS content, m.role FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ? AND c.id = ? AND c.project_id = ? AND m.role IN ('user', 'assistant')
    `).get(entry.source.messageId, entry.source.conversationId, input.projectId) as { content: string; role: "user" | "assistant" } | undefined;
    if (!row) throw new ProjectMemoryError("The source message is no longer available.");
    let content = row.content;
    if (content.length <= 4000) {
      const chunks = this.database.prepare(`
        SELECT substr(content, 1, 4001) AS content FROM message_content_chunks
        WHERE message_id = ? ORDER BY sequence ASC
      `).iterate(entry.source.messageId) as IterableIterator<{ content: string }>;
      for (const chunk of chunks) {
        content += chunk.content;
        if (content.length > 4000) break;
      }
    }
    return { projectId: input.projectId, id: input.id, source: entry.source, role: row.role,
      content: content.slice(0, 4000), truncated: content.length > 4000 };
  }

  /** Reveal only this feature's frozen context, never arbitrary execution blobs. */
  sentContext(input: Payload<"project.memory.context">): string | null {
    this.assertScope(input);
    if (!this.database.prepare("SELECT 1 FROM agent_turns WHERE id = ? AND conversation_id = ?").get(input.turnId, input.conversationId)) {
      throw new ProjectMemoryError("This turn does not belong to the selected chat.");
    }
    const row = this.database.prepare(`
      SELECT b.content, b.digest FROM turn_execution_context_refs r
      JOIN turn_execution_context_blobs b ON b.digest = r.digest
      WHERE r.turn_id = ? AND r.kind = 'attachment' AND r.label = ?
    `).get(input.turnId, PROJECT_MEMORY_CONTEXT_LABEL) as { content: string; digest: string } | undefined;
    if (!row) return null;
    if (Buffer.byteLength(row.content, "utf8") > MAX_PROJECT_MEMORY_CONTEXT_BYTES
      || createHash("sha256").update(row.content, "utf8").digest("hex") !== row.digest) {
      throw new ProjectMemoryError("The saved project context could not be verified.");
    }
    return row.content;
  }
}
