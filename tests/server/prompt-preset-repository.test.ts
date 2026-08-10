import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  PromptPresetRepository,
  PromptPresetRepositoryError,
} from "../../src/server/persistence/prompt-preset-repository";
import {
  promptPresetMigrationDefinition,
} from "../../src/server/persistence/migrations/prompt-presets";
import {
  MAX_PROMPT_PRESETS,
  MAX_PROMPT_PRESETS_SERIALIZED_BYTES,
  promptPresetsSerializedBytes,
} from "../../src/shared/prompt-presets";

const databases: Database.Database[] = [];
const route = {
  harnessId: "codex-app-server",
  backendProfileId: "builtin:openai",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
} as const;

function escapedRoute(controlCharacters: number) {
  return {
    harnessId: "h".repeat(200),
    backendProfileId: "b".repeat(200),
    modelId: "m".repeat(300),
    reasoningEffort: "\u0001".repeat(controlCharacters),
  };
}

function repository(): PromptPresetRepository {
  const database = new Database(":memory:");
  databases.push(database);
  if (typeof promptPresetMigrationDefinition.up !== "string") {
    throw new Error("Expected the prompt preset migration to use bounded SQL.");
  }
  database.exec(promptPresetMigrationDefinition.up);
  database.exec(promptPresetMigrationDefinition.up);
  let tick = 0;
  return new PromptPresetRepository(database, () =>
    new Date(Date.UTC(2026, 7, 10, 10, 0, tick++)).toISOString());
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("PromptPresetRepository", () => {
  it("creates, edits, duplicates, reorders, and deletes durable presets", () => {
    const presets = repository();
    const first = presets.create({
      name: "Review",
      body: "Review the current patch.",
      route,
    });
    const second = presets.create({
      name: "Explain",
      body: "Explain the selected code.",
      route: null,
    });
    const updated = presets.update(first.id, first.revision, {
      name: "Review carefully",
    });
    const duplicate = presets.duplicate(second.id, second.revision);

    expect(updated).toMatchObject({
      name: "Review carefully",
      body: first.body,
      route,
      revision: 2,
    });
    expect(duplicate).toMatchObject({
      name: "Explain copy",
      body: second.body,
      route: null,
      position: 2,
    });

    presets.reorder(
      [updated.id, second.id, duplicate.id],
      [duplicate.id, updated.id, second.id],
    );
    expect(presets.list().map(({ id, position }) => [id, position])).toEqual([
      [duplicate.id, 0],
      [updated.id, 1],
      [second.id, 2],
    ]);
    presets.delete(updated.id, updated.revision);
    expect(presets.list().map(({ id, position }) => [id, position])).toEqual([
      [duplicate.id, 0],
      [second.id, 1],
    ]);
  });

  it("rejects stale rapid edits without overwriting the latest body", () => {
    const presets = repository();
    const created = presets.create({
      name: "Race audit",
      body: "First body",
      route: null,
    });
    const latest = presets.update(created.id, created.revision, {
      body: "Latest body",
    });

    expect(() => presets.update(created.id, created.revision, {
      body: "Stale body",
    })).toThrow(PromptPresetRepositoryError);
    expect(presets.list()[0]).toMatchObject({
      body: "Latest body",
      revision: latest.revision,
    });

    const second = presets.create({
      name: "Second",
      body: "Second body",
      route: null,
    });
    expect(() => presets.reorder(
      [created.id],
      [second.id, created.id],
    )).toThrow(PromptPresetRepositoryError);
    expect(presets.list().map(({ id }) => id)).toEqual([
      created.id,
      second.id,
    ]);
  });

  it("bounds count and aggregate serialized UTF-8 bytes transactionally", () => {
    const countBound = repository();
    for (let index = 0; index < MAX_PROMPT_PRESETS; index += 1) {
      countBound.create({
        name: `Preset ${index}`,
        body: `Body ${index}`,
        route: null,
      });
    }
    expect(() => countBound.create({
      name: "One too many",
      body: "Rejected",
      route: null,
    })).toThrow(`Prompt presets are limited to ${MAX_PROMPT_PRESETS}.`);
    expect(countBound.list()).toHaveLength(MAX_PROMPT_PRESETS);

    const byteBound = repository();
    let accepted = 0;
    while (true) {
      try {
        byteBound.create({
          name: `Unicode ${accepted}`,
          body: "🧭".repeat(10_000),
          route: null,
        });
        accepted += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(PromptPresetRepositoryError);
        break;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(promptPresetsSerializedBytes(byteBound.list()))
      .toBeLessThanOrEqual(MAX_PROMPT_PRESETS_SERIALIZED_BYTES);
  });

  it("rejects escaped route JSON before create or update reaches SQLite", () => {
    const presets = repository();
    const maximum = presets.create({
      name: "Maximum route",
      body: "The exact persisted route bound is accepted.",
      route: escapedRoute(42),
    });
    const updateTarget = presets.create({
      name: "Update target",
      body: "Exercise the update boundary independently.",
      route: null,
    });
    const maximumUpdate = presets.update(
      updateTarget.id,
      updateTarget.revision,
      { route: escapedRoute(42) },
    );

    expect(() => presets.create({
      name: "Create overflow",
      body: "This route expands when JSON escaped.",
      route: escapedRoute(43),
    })).toThrow(PromptPresetRepositoryError);
    expect(() => presets.update(maximumUpdate.id, maximumUpdate.revision, {
      route: escapedRoute(43),
    })).toThrow(PromptPresetRepositoryError);
    expect(presets.list()).toEqual([maximum, maximumUpdate]);
  });
});
