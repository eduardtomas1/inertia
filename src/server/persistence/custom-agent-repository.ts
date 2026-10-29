import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  customAgentDraftSchema,
  customAgentSchema,
  duplicateCustomAgentName,
  MAX_CUSTOM_AGENTS,
  uniqueCustomAgentHandle,
  type CustomAgent,
  type CustomAgentDraft,
} from "../../shared/custom-agents";

interface CustomAgentRow {
  id: string;
  name: string;
  handle: string;
  description: string;
  icon_json: string;
  accent: string | null;
  blocks_json: string;
  skills_json: string;
  position: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type CustomAgentHandleConflict = "reject" | "rename";

export type CustomAgentRepositoryErrorCode =
  | "invalid"
  | "missing"
  | "stale"
  | "handle-taken"
  | "limit";

export class CustomAgentRepositoryError extends Error {
  constructor(
    readonly code: CustomAgentRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CustomAgentRepositoryError";
  }
}

const AGENT_COLUMNS = `
  id, name, handle, description, icon_json, accent, blocks_json, skills_json,
  position, revision, created_at, updated_at
`;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function agentFromRow(row: CustomAgentRow): CustomAgent | null {
  const parsed = customAgentSchema.safeParse({
    id: row.id,
    name: row.name,
    handle: row.handle,
    description: row.description,
    icon: parseJson(row.icon_json),
    accent: row.accent,
    blocks: parseJson(row.blocks_json),
    skills: parseJson(row.skills_json),
    position: row.position,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

function parseDraft(input: CustomAgentDraft): CustomAgentDraft {
  const parsed = customAgentDraftSchema.safeParse(input);
  if (!parsed.success) {
    throw new CustomAgentRepositoryError(
      "invalid",
      parsed.error.issues[0]?.message ?? "The agent is invalid.",
    );
  }
  return parsed.data;
}

function handleTaken(handle: string): CustomAgentRepositoryError {
  return new CustomAgentRepositoryError(
    "handle-taken",
    `Another agent already uses @${handle}. Pick a different handle.`,
  );
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

export class CustomAgentRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): CustomAgent[] {
    return (this.database.prepare(`
      SELECT ${AGENT_COLUMNS} FROM custom_agents
      ORDER BY position ASC, id ASC
    `).all() as CustomAgentRow[]).flatMap((row) => {
      const agent = agentFromRow(row);
      return agent ? [agent] : [];
    });
  }

  get(agentId: string): CustomAgent | null {
    const row = this.database.prepare(
      `SELECT ${AGENT_COLUMNS} FROM custom_agents WHERE id = ?`,
    ).get(agentId) as CustomAgentRow | undefined;
    return row ? agentFromRow(row) : null;
  }

  getByHandle(handle: string): CustomAgent | null {
    const row = this.database.prepare(
      `SELECT ${AGENT_COLUMNS} FROM custom_agents WHERE handle = ?`,
    ).get(handle) as CustomAgentRow | undefined;
    return row ? agentFromRow(row) : null;
  }

  create(
    input: CustomAgentDraft,
    options: { onHandleConflict: CustomAgentHandleConflict },
  ): CustomAgent {
    const draft = parseDraft(input);
    return this.database.transaction(() => {
      const count = this.storedIds().length;
      this.assertRoom(count);
      const taken = this.takenHandles();
      if (taken.has(draft.handle) && options.onHandleConflict === "reject") {
        throw handleTaken(draft.handle);
      }
      const timestamp = this.now();
      const agent = this.parseAgent({
        ...draft,
        handle: uniqueCustomAgentHandle(draft.handle, taken),
        id: randomUUID(),
        position: count,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.insert(agent);
      return agent;
    })();
  }

  update(
    agentId: string,
    expectedRevision: number,
    patch: Partial<CustomAgentDraft>,
  ): CustomAgent {
    return this.database.transaction(() => {
      const existing = this.requireCurrent(agentId, expectedRevision);
      const draft = parseDraft({
        name: patch.name ?? existing.name,
        handle: patch.handle ?? existing.handle,
        description: patch.description ?? existing.description,
        icon: patch.icon ?? existing.icon,
        accent: patch.accent === undefined ? existing.accent : patch.accent,
        blocks: patch.blocks ?? existing.blocks,
        skills: patch.skills ?? existing.skills,
      });
      if (draft.handle !== existing.handle && this.takenHandles().has(draft.handle)) {
        throw handleTaken(draft.handle);
      }
      const next = this.parseAgent({
        ...existing,
        ...draft,
        revision: existing.revision + 1,
        updatedAt: this.now(),
      });
      let changes: number;
      try {
        changes = this.database.prepare(`
          UPDATE custom_agents SET
            name = ?, handle = ?, description = ?, icon_json = ?, accent = ?,
            blocks_json = ?, skills_json = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(
          next.name,
          next.handle,
          next.description,
          JSON.stringify(next.icon),
          next.accent,
          JSON.stringify(next.blocks),
          JSON.stringify(next.skills),
          next.revision,
          next.updatedAt,
          agentId,
          expectedRevision,
        ).changes;
      } catch (error) {
        if (uniqueViolation(error)) throw handleTaken(next.handle);
        throw error;
      }
      if (changes !== 1) this.throwStale();
      return next;
    })();
  }

  duplicate(agentId: string, expectedRevision: number): CustomAgent {
    return this.database.transaction(() => {
      const source = this.requireCurrent(agentId, expectedRevision);
      const ids = this.storedIds();
      this.assertRoom(ids.length);
      const position = ids.indexOf(source.id) + 1;
      const timestamp = this.now();
      const duplicate = this.parseAgent({
        name: duplicateCustomAgentName(source.name),
        handle: uniqueCustomAgentHandle(source.handle.replace(/-\d+$/u, ""), this.takenHandles()),
        description: source.description,
        icon: source.icon,
        accent: source.accent,
        blocks: source.blocks.map((block) => ({ ...block, id: randomUUID() })),
        skills: [...source.skills],
        id: randomUUID(),
        position,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.writePositions(ids, (index) => index < position ? index : index + 1);
      this.insert(duplicate);
      return duplicate;
    })();
  }

  delete(agentId: string, expectedRevision: number): void {
    this.database.transaction(() => {
      this.requireCurrent(agentId, expectedRevision);
      const result = this.database.prepare(
        "DELETE FROM custom_agents WHERE id = ? AND revision = ?",
      ).run(agentId, expectedRevision);
      if (result.changes !== 1) this.throwStale();
      this.writePositions(this.storedIds());
    })();
  }

  reorder(
    expectedAgentIds: readonly string[],
    agentIds: readonly string[],
  ): CustomAgent[] {
    return this.database.transaction(() => {
      const currentIds = this.list().map(({ id }) => id);
      const known = new Set(currentIds);
      if (
        expectedAgentIds.length !== currentIds.length
        || expectedAgentIds.some((id, index) => id !== currentIds[index])
        || agentIds.length !== currentIds.length
        || new Set(agentIds).size !== agentIds.length
        || agentIds.some((id) => !known.has(id))
      ) {
        throw new CustomAgentRepositoryError(
          "stale",
          "Custom agents changed before they could be reordered. Try again.",
        );
      }
      const ordered = new Set(agentIds);
      this.writePositions([
        ...agentIds,
        ...this.storedIds().filter((id) => !ordered.has(id)),
      ]);
      return this.list();
    })();
  }

  private parseAgent(value: CustomAgent): CustomAgent {
    const parsed = customAgentSchema.safeParse(value);
    if (!parsed.success) {
      throw new CustomAgentRepositoryError(
        "invalid",
        parsed.error.issues[0]?.message ?? "The agent is invalid.",
      );
    }
    return parsed.data;
  }

  private insert(agent: CustomAgent): void {
    try {
      this.database.prepare(`
        INSERT INTO custom_agents (${AGENT_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        agent.id,
        agent.name,
        agent.handle,
        agent.description,
        JSON.stringify(agent.icon),
        agent.accent,
        JSON.stringify(agent.blocks),
        JSON.stringify(agent.skills),
        agent.position,
        agent.revision,
        agent.createdAt,
        agent.updatedAt,
      );
    } catch (error) {
      if (uniqueViolation(error)) throw handleTaken(agent.handle);
      throw error;
    }
  }

  private storedIds(): string[] {
    return (this.database.prepare(
      "SELECT id FROM custom_agents ORDER BY position ASC, id ASC",
    ).all() as Array<{ id: string }>).map(({ id }) => id);
  }

  private takenHandles(): Set<string> {
    return new Set((this.database.prepare(
      "SELECT handle FROM custom_agents",
    ).all() as Array<{ handle: string }>).map(({ handle }) => handle));
  }

  private writePositions(
    ids: readonly string[],
    positionAt: (index: number) => number = (index) => index,
  ): void {
    const update = this.database.prepare(
      "UPDATE custom_agents SET position = ? WHERE id = ? AND position <> ?",
    );
    ids.forEach((id, index) => {
      const position = positionAt(index);
      update.run(position, id, position);
    });
  }

  private assertRoom(count: number): void {
    if (count >= MAX_CUSTOM_AGENTS) {
      throw new CustomAgentRepositoryError(
        "limit",
        `Custom agents are limited to ${MAX_CUSTOM_AGENTS}.`,
      );
    }
  }

  private requireCurrent(agentId: string, expectedRevision: number): CustomAgent {
    const agent = this.get(agentId);
    if (!agent) {
      throw new CustomAgentRepositoryError("missing", "The agent no longer exists.");
    }
    if (agent.revision !== expectedRevision) this.throwStale();
    return agent;
  }

  private throwStale(): never {
    throw new CustomAgentRepositoryError(
      "stale",
      "The agent changed elsewhere. Review the latest version and try again.",
    );
  }
}
