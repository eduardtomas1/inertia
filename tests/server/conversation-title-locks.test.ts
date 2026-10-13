import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = (name: string) => {
    const path = join(directory, name);
    mkdirSync(path);
    const created = store.createProject(name, path);
    const chats = [store.createConversation(created.id, `${name} one`), store.createConversation(created.id, `${name} two`)];
    for (const { id } of chats) store.conversationTitleLocks.add(id);
    return { id: created.id, chatIds: chats.map(({ id }) => id) };
  };
  return { store, project };
}

describe("conversation title locks", () => {
  it("forgets a deleted chat's title lock", () => {
    const { store, project } = lockedChats();
    const { chatIds: [deleted, kept] } = project("work");

    store.deleteConversation(deleted!);

    expect([...store.conversationTitleLocks]).toEqual([kept]);
  });

  it("forgets the title locks of every chat in a removed project", () => {
    const { store, project } = lockedChats();
    const removed = project("removed");
    const kept = project("kept");

    store.removeProject(removed.id);

    expect([...store.conversationTitleLocks]).toEqual(kept.chatIds);
  });
});
