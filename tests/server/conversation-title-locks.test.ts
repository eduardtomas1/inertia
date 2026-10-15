import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function lockedChats() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-title-locks-"));
  directories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  const open = () => {
    const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
    stores.push(store);
    return store;
  };
  const store = open();
  const project = (name: string) => {
    const path = join(directory, name);
    mkdirSync(path);
    const created = store.createProject(name, path);
    const chats = [store.createConversation(created.id, `${name} one`), store.createConversation(created.id, `${name} two`)];
    for (const { id } of chats) store.lockConversationTitle(id);
    return { id: created.id, chatIds: chats.map(({ id }) => id) };
  };
  const locks = () => {
    const database = new Database(databasePath, { readonly: true });
    try {
      return database.prepare("SELECT conversation_id FROM conversation_title_locks ORDER BY rowid").pluck().all();
    } finally {
      database.close();
    }
  };
  return { store, open, project, locks };
}

describe("conversation title locks", () => {
  it("keeps title locks when the store is reopened", () => {
    const { store, open, project } = lockedChats();
    const { id: projectId, chatIds: [locked] } = project("work");
    const unlocked = store.createConversation(projectId, "work three");
    store.close();

    const reopened = open();

    expect(reopened.conversationTitleLocked(locked!)).toBe(true);
    expect(reopened.conversationTitleLocked(unlocked.id)).toBe(false);
  });

  it("refuses to lock the title of a chat that does not exist", () => {
    const { store, locks } = lockedChats();

    expect(() => store.lockConversationTitle("99999999-9999-4999-8999-999999999999")).toThrow();
    expect(locks()).toEqual([]);
  });

  it("forgets a deleted chat's title lock", () => {
    const { store, project, locks } = lockedChats();
    const { chatIds: [deleted, kept] } = project("work");

    store.deleteConversation(deleted!);

    expect(locks()).toEqual([kept]);
  });

  it("forgets the title locks of every chat in a removed project", () => {
    const { store, project, locks } = lockedChats();
    const removed = project("removed");
    const kept = project("kept");

    store.removeProject(removed.id);

    expect(locks()).toEqual(kept.chatIds);
  });
});
