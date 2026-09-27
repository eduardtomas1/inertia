import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const directories: string[] = [];

function storeWithProjects() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-project-removal-"));
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, {
    recoverInterruptedRuns: false,
  });
  const project = (name: string) => {
    const path = join(directory, name);
    mkdirSync(path);
    const created = store.createProject(name, path);
    const conversation = store.createConversation(created.id, `${name} chat`);
    return { id: created.id, conversationId: conversation.id };
  };
  return { store, project };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project removal selection", () => {
  it("keeps the active project and chat when another project is removed", () => {
    const { store, project } = storeWithProjects();
    try {
      const selected = project("selected");
      const removed = project("removed");
      const recent = project("recent");
      store.selectProject(selected.id);
      store.selectConversation(selected.conversationId);

      store.removeProject(removed.id);

      const snapshot = store.snapshot();
      expect(snapshot.projects.map(({ id }) => id)).toEqual(
        expect.arrayContaining([selected.id, recent.id]),
      );
      expect(snapshot.activeProjectId).toBe(selected.id);
      expect(snapshot.activeConversationId).toBe(selected.conversationId);
    } finally {
      store.close();
    }
  });

  it("selects the most recently updated project when the active project is removed", () => {
    const { store, project } = storeWithProjects();
    try {
      const older = project("older");
      const recent = project("recent");
      const active = project("active");
      store.updateProject(recent.id, { name: "recent renamed" });
      store.selectProject(active.id);

      store.removeProject(active.id);

      const snapshot = store.snapshot();
      expect(snapshot.activeProjectId).toBe(recent.id);
      expect(snapshot.activeConversationId).toBe(recent.conversationId);
      expect(snapshot.projects.map(({ id }) => id)).toContain(older.id);
    } finally {
      store.close();
    }
  });
});
