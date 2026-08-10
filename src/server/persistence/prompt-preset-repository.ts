import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  duplicatePromptPresetName,
  MAX_PROMPT_PRESETS,
  MAX_PROMPT_PRESETS_SERIALIZED_BYTES,
  promptPresetDraftSchema,
  promptPresetRouteSchema,
  promptPresetSchema,
  promptPresetsSerializedBytes,
  type PromptPreset,
  type PromptPresetDraft,
} from "../../shared/prompt-presets";

interface PromptPresetRow {
  id: string;
  name: string;
  body: string;
  route_json: string | null;
  position: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export class PromptPresetRepositoryError extends Error {}

function presetFromRow(row: PromptPresetRow): PromptPreset {
  let route: unknown = null;
  if (row.route_json !== null) {
    try {
      route = JSON.parse(row.route_json) as unknown;
    } catch {
      throw new Error("Stored prompt preset route is invalid.");
    }
  }
  return promptPresetSchema.parse({
    id: row.id,
    name: row.name,
    body: row.body,
    route,
    position: row.position,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function routeJson(route: PromptPresetDraft["route"]): string | null {
  if (route === null) return null;
  const parsed = promptPresetRouteSchema.safeParse(route);
  if (!parsed.success) throwInvalidPreset(parsed.error.issues[0]?.message);
  return JSON.stringify(parsed.data);
}

function parseDraft(input: PromptPresetDraft): PromptPresetDraft {
  const parsed = promptPresetDraftSchema.safeParse(input);
  if (!parsed.success) throwInvalidPreset(parsed.error.issues[0]?.message);
  return parsed.data;
}

function throwInvalidPreset(detail?: string): never {
  throw new PromptPresetRepositoryError(
    detail ?? "The prompt preset is invalid.",
  );
}

export class PromptPresetRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): PromptPreset[] {
    return (this.database.prepare(`
      SELECT id, name, body, route_json, position, revision,
        created_at, updated_at
      FROM prompt_presets
      ORDER BY position ASC, id ASC
    `).all() as PromptPresetRow[]).map(presetFromRow);
  }

  create(input: PromptPresetDraft): PromptPreset {
    const draft = parseDraft(input);
    return this.database.transaction(() => {
      const current = this.list();
      this.assertRoom(current);
      const timestamp = this.now();
      const preset = promptPresetSchema.parse({
        ...draft,
        id: randomUUID(),
        position: current.length,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.assertSerializedBound([...current, preset]);
      this.database.prepare(`
        INSERT INTO prompt_presets (
          id, name, body, route_json, position, revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        preset.id,
        preset.name,
        preset.body,
        routeJson(preset.route),
        preset.position,
        preset.revision,
        preset.createdAt,
        preset.updatedAt,
      );
      return preset;
    })();
  }

  update(
    presetId: string,
    expectedRevision: number,
    update: Partial<PromptPresetDraft>,
  ): PromptPreset {
    return this.database.transaction(() => {
      const current = this.list();
      const existing = this.requireCurrent(
        current,
        presetId,
        expectedRevision,
      );
      const draft = parseDraft({
        name: update.name ?? existing.name,
        body: update.body ?? existing.body,
        route: update.route === undefined ? existing.route : update.route,
      });
      const next = promptPresetSchema.parse({
        ...existing,
        ...draft,
        revision: existing.revision + 1,
        updatedAt: this.now(),
      });
      this.assertSerializedBound(current.map((preset) =>
        preset.id === presetId ? next : preset));
      const result = this.database.prepare(`
        UPDATE prompt_presets SET
          name = ?, body = ?, route_json = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        next.name,
        next.body,
        routeJson(next.route),
        next.revision,
        next.updatedAt,
        presetId,
        expectedRevision,
      );
      if (result.changes !== 1) this.throwStale();
      return next;
    })();
  }

  duplicate(presetId: string, expectedRevision: number): PromptPreset {
    return this.database.transaction(() => {
      const current = this.list();
      const source = this.requireCurrent(
        current,
        presetId,
        expectedRevision,
      );
      this.assertRoom(current);
      const position = source.position + 1;
      const timestamp = this.now();
      const duplicate = promptPresetSchema.parse({
        name: duplicatePromptPresetName(source.name),
        body: source.body,
        route: source.route,
        id: randomUUID(),
        position,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const candidate = [
        ...current.slice(0, position),
        duplicate,
        ...current.slice(position).map((preset) => ({
          ...preset,
          position: preset.position + 1,
        })),
      ];
      this.assertSerializedBound(candidate);
      this.database.prepare(
        "UPDATE prompt_presets SET position = position + 1 WHERE position >= ?",
      ).run(position);
      this.database.prepare(`
        INSERT INTO prompt_presets (
          id, name, body, route_json, position, revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        duplicate.id,
        duplicate.name,
        duplicate.body,
        routeJson(duplicate.route),
        duplicate.position,
        duplicate.revision,
        duplicate.createdAt,
        duplicate.updatedAt,
      );
      return duplicate;
    })();
  }

  delete(presetId: string, expectedRevision: number): void {
    this.database.transaction(() => {
      const current = this.list();
      this.requireCurrent(current, presetId, expectedRevision);
      const result = this.database.prepare(
        "DELETE FROM prompt_presets WHERE id = ? AND revision = ?",
      ).run(presetId, expectedRevision);
      if (result.changes !== 1) this.throwStale();
      this.normalizePositions();
    })();
  }

  reorder(
    expectedPresetIds: readonly string[],
    presetIds: readonly string[],
  ): void {
    this.database.transaction(() => {
      const current = this.list();
      const currentIds = current.map(({ id }) => id);
      if (
        expectedPresetIds.length !== currentIds.length
        || expectedPresetIds.some((id, index) => id !== currentIds[index])
        || presetIds.length !== current.length
        || new Set(presetIds).size !== presetIds.length
        || presetIds.some((id) => !current.some((preset) => preset.id === id))
      ) {
        throw new PromptPresetRepositoryError(
          "Prompt presets changed before they could be reordered. Try again.",
        );
      }
      const update = this.database.prepare(
        "UPDATE prompt_presets SET position = ? WHERE id = ?",
      );
      presetIds.forEach((id, position) => update.run(position, id));
    })();
  }

  private normalizePositions(): void {
    const update = this.database.prepare(
      "UPDATE prompt_presets SET position = ? WHERE id = ?",
    );
    this.list().forEach((preset, position) => update.run(position, preset.id));
  }

  private assertRoom(current: readonly PromptPreset[]): void {
    if (current.length >= MAX_PROMPT_PRESETS) {
      throw new PromptPresetRepositoryError(
        `Prompt presets are limited to ${MAX_PROMPT_PRESETS}.`,
      );
    }
  }

  private assertSerializedBound(presets: readonly PromptPreset[]): void {
    if (
      promptPresetsSerializedBytes(presets)
      > MAX_PROMPT_PRESETS_SERIALIZED_BYTES
    ) {
      throw new PromptPresetRepositoryError(
        "Prompt presets exceed the safe local storage limit.",
      );
    }
  }

  private requireCurrent(
    presets: readonly PromptPreset[],
    presetId: string,
    expectedRevision: number,
  ): PromptPreset {
    const preset = presets.find(({ id }) => id === presetId);
    if (!preset) {
      throw new PromptPresetRepositoryError("The prompt preset no longer exists.");
    }
    if (preset.revision !== expectedRevision) this.throwStale();
    return preset;
  }

  private throwStale(): never {
    throw new PromptPresetRepositoryError(
      "The prompt preset changed elsewhere. Review the latest version and try again.",
    );
  }
}
