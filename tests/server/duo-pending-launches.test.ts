import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const temporaryDirectories: string[] = [];

async function runtime(): Promise<{
  databasePath: string;
  projectId: string;
  store: RuntimeStore;
  workspace: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-duo-pending-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Duo project", workspace);
  return { databasePath, projectId: project.id, store, workspace };
}

function createPending(
  store: RuntimeStore,
  launchId: string,
  projectIds: readonly [string, string],
  createdAt: string,
): [string, string] {
  const conversationIds = [randomUUID(), randomUUID()] as [string, string];
  store.createPairedLaunch(launchId, [0, 1].map((ordinal) => ({
    ordinal: ordinal as 0 | 1,
    projectId: projectIds[ordinal]!,
    plannedConversationId: conversationIds[ordinal]!,
    plannedWorktreePath: null,
    plannedBranch: "main",
    ownsWorktree: false,
  })) as Parameters<RuntimeStore["createPairedLaunch"]>[1], createdAt);
  return conversationIds;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("pending Duo launch discovery", () => {
  it("protects interrupted identity until an idempotent acknowledgement", async () => {
    const fixture = await runtime();
    try {
      const launchId = randomUUID();
      const conversationIds = createPending(
        fixture.store,
        launchId,
        [fixture.projectId, fixture.projectId],
        "2026-08-02T10:00:00.000Z",
      );
      const conversations = fixture.store.createPairedConversations(launchId, [
        { projectId: fixture.projectId, title: "Left", options: { id: conversationIds[0], activate: false } },
        { projectId: fixture.projectId, title: "Right", options: { id: conversationIds[1], activate: false } },
      ]);
      fixture.store.failPairedLaunch(
        launchId,
        "interrupted",
        "Provider acceptance could not be confirmed.",
      );

      expect(() => fixture.store.deleteConversation(conversations[0].id))
        .toThrow(/acknowledge an interrupted dispatch/u);
      expect(() => fixture.store.removeProject(fixture.projectId))
        .toThrow(/acknowledge an interrupted dispatch/u);
      expect(fixture.store.pendingPairedLaunchIds([fixture.projectId], 16))
        .toEqual({ launchIds: [launchId], hasMore: false });

      const acknowledged = fixture.store.acknowledgeInterruptedPairedLaunch(
        launchId,
      );
      expect(acknowledged).toMatchObject({
        state: "failed",
        error: expect.stringContaining(
          "Uncertain provider dispatch acknowledged by the user.",
        ),
      });
      expect(fixture.store.acknowledgeInterruptedPairedLaunch(launchId))
        .toEqual(acknowledged);
      expect(fixture.store.pendingPairedLaunchIds([fixture.projectId], 16))
        .toEqual({ launchIds: [], hasMore: false });
      fixture.store.deleteConversation(conversations[0].id);
      expect(fixture.store.findPairedLaunch(launchId)).toBeNull();
    } finally {
      fixture.store.close();
    }
  });

  it("uses exact project identities across rename, deletion, and restart", async () => {
    const fixture = await runtime();
    let originalClosed = false;
    let reopened: RuntimeStore | null = null;
    try {
      const secondPath = join(fixture.workspace, "..", "second-project");
      const thirdPath = join(fixture.workspace, "..", "third-project");
      const deletedPath = join(fixture.workspace, "..", "deleted-project");
      await Promise.all([
        mkdir(secondPath),
        mkdir(thirdPath),
        mkdir(deletedPath),
      ]);
      const second = fixture.store.createProject("Second", secondPath);
      const third = fixture.store.createProject("Third", thirdPath);
      const deleted = fixture.store.createProject("Deleted", deletedPath);
      const launchIds = {
        first: "00000000-0000-4000-8000-000000000001",
        cross: "00000000-0000-4000-8000-000000000002",
        second: "00000000-0000-4000-8000-000000000003",
        third: "00000000-0000-4000-8000-000000000004",
        deleted: "00000000-0000-4000-8000-000000000005",
        interrupted: "00000000-0000-4000-8000-000000000006",
      };
      createPending(
        fixture.store,
        launchIds.first,
        [fixture.projectId, fixture.projectId],
        "2026-08-02T10:00:00.000Z",
      );
      createPending(
        fixture.store,
        launchIds.cross,
        [fixture.projectId, second.id],
        "2026-08-02T10:01:00.000Z",
      );
      fixture.store.failPairedLaunch(
        launchIds.cross,
        "recovery-required",
        "Cross-project launch needs recovery.",
      );
      createPending(
        fixture.store,
        launchIds.second,
        [second.id, second.id],
        "2026-08-02T10:02:00.000Z",
      );
      createPending(
        fixture.store,
        launchIds.third,
        [third.id, third.id],
        "2026-08-02T10:03:00.000Z",
      );
      createPending(
        fixture.store,
        launchIds.deleted,
        [deleted.id, deleted.id],
        "2026-08-02T10:04:00.000Z",
      );
      fixture.store.failPairedLaunch(
        launchIds.deleted,
        "failed",
        "Terminal launch before project deletion.",
      );
      createPending(
        fixture.store,
        launchIds.interrupted,
        [fixture.projectId, fixture.projectId],
        "2026-08-02T10:05:00.000Z",
      );
      fixture.store.failPairedLaunch(
        launchIds.interrupted,
        "interrupted",
        "Dispatch acknowledgement was interrupted.",
      );
      fixture.store.removeProject(deleted.id);
      fixture.store.updateProject(second.id, { name: "Renamed second" });

      expect(fixture.store.pendingPairedLaunchIds([fixture.projectId], 16))
        .toEqual({
          launchIds: [
            launchIds.interrupted,
            launchIds.cross,
            launchIds.first,
          ],
          hasMore: false,
        });
      expect(fixture.store.pendingPairedLaunchIds([second.id], 16)).toEqual({
        launchIds: [launchIds.second, launchIds.cross],
        hasMore: false,
      });
      expect(fixture.store.pendingPairedLaunchIds([
        fixture.projectId,
        second.id,
        third.id,
      ], 16)).toEqual({
        launchIds: [
          launchIds.interrupted,
          launchIds.third,
          launchIds.second,
          launchIds.cross,
          launchIds.first,
        ],
        hasMore: false,
      });
      expect(fixture.store.pendingPairedLaunchIds([third.id], 16)).toEqual({
        launchIds: [launchIds.third],
        hasMore: false,
      });
      expect(fixture.store.pendingPairedLaunchIds([deleted.id], 16)).toEqual({
        launchIds: [],
        hasMore: false,
      });

      fixture.store.close();
      originalClosed = true;
      reopened = new RuntimeStore(
        fixture.databasePath,
        fixture.workspace,
        { recoverInterruptedRuns: false },
      );
      expect(reopened.pendingPairedLaunchIds([
        fixture.projectId,
        second.id,
      ], 16)).toEqual({
        launchIds: [
          launchIds.interrupted,
          launchIds.second,
          launchIds.cross,
          launchIds.first,
        ],
        hasMore: false,
      });
    } finally {
      reopened?.close();
      if (!originalClosed) fixture.store.close();
    }
  });

  it("bounds blockers in stable newest-first and ID order", async () => {
    const fixture = await runtime();
    try {
      const launchIds = Array.from({ length: 18 }, (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
      for (const [index, launchId] of launchIds.entries()) {
        createPending(
          fixture.store,
          launchId,
          [fixture.projectId, fixture.projectId],
          index < 2
            ? "2026-08-02T10:00:00.000Z"
            : index >= 16
              ? "2026-08-02T10:59:00.000Z"
              : `2026-08-02T10:${String(index).padStart(2, "0")}:00.000Z`,
        );
      }

      expect(fixture.store.pendingPairedLaunchIds([fixture.projectId], 16))
        .toEqual({
          launchIds: [
            launchIds[16]!,
            launchIds[17]!,
            ...launchIds.slice(2, 16).reverse(),
          ],
          hasMore: true,
        });
    } finally {
      fixture.store.close();
    }
  });
});
