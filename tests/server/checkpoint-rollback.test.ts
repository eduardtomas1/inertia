import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("checkpoint rollback", () => {
  it("removes only the exact unassociated checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-checkpoint-rollback-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspace);
    const project = store.createProject("Checkpoint rollback", workspace);
    const conversation = store.createConversation(project.id, "Target");
    const other = store.createConversation(project.id, "Other");
    const checkpoint = store.addCheckpoint({
      conversationId: conversation.id,
      ref: "refs/inertia/checkpoints/unassociated",
      label: "Unassociated checkpoint",
      turnIndex: 1,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });

    expect(store.removeUnassociatedCheckpoint(checkpoint.id, other.id))
      .toBe(false);
    expect(store.checkpoint(checkpoint.id).turnId).toBeNull();
    expect(store.removeUnassociatedCheckpoint(checkpoint.id, conversation.id))
      .toBe(true);
    expect(() => store.checkpoint(checkpoint.id)).toThrow("not found");
    expect(store.removeUnassociatedCheckpoint(checkpoint.id, conversation.id))
      .toBe(false);
    store.close();
  });
});
