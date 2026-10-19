import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { appKeybindings } from "../../src/shared/contracts/app-keybindings-schema";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function storeWithKeybindings(stored: string): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-keybindings-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  new RuntimeStore(databasePath, workspacePath).close();
  const database = new Database(databasePath);
  database.prepare("UPDATE app_state SET keybindings_json = ? WHERE id = 1").run(stored);
  database.close();
  return new RuntimeStore(databasePath, workspacePath);
}

describe("stored app shortcuts", () => {
  it("keeps shortcuts saved before the surface shortcut and adds it on its default key", async () => {
    const store = await storeWithKeybindings(JSON.stringify({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "b",
      "toggle-terminal": "h",
    }));
    const keybindings = store.snapshot().settings.keybindings;
    expect(keybindings).toEqual({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "b",
      "toggle-terminal": "h",
      "open-surface": "g",
    });
    expect(appKeybindings(keybindings)).toBe(true);
    store.close();
  });

  it("moves the surface shortcut to the first free key when an older choice took G", async () => {
    const store = await storeWithKeybindings(JSON.stringify({
      search: "u",
      "new-chat": "y",
      "toggle-sidebar": "g",
      "toggle-terminal": "h",
    }));
    expect(store.snapshot().settings.keybindings["open-surface"]).toBe("b");
    store.close();
  });

  it("reads the original default row as the current defaults", async () => {
    const store = await storeWithKeybindings('{"search":"k","new-chat":"n","toggle-sidebar":"b","toggle-terminal":"j"}');
    expect(store.snapshot().settings.keybindings).toEqual(DEFAULT_APP_KEYBINDINGS);
    store.close();
  });

  it("only accepts complete, unique records in snapshots", () => {
    expect(appKeybindings(DEFAULT_APP_KEYBINDINGS)).toBe(true);
    const { "open-surface": _omitted, ...legacy } = DEFAULT_APP_KEYBINDINGS;
    expect(appKeybindings(legacy)).toBe(false);
    expect(appKeybindings({ ...DEFAULT_APP_KEYBINDINGS, "open-surface": "k" })).toBe(false);
  });
});
