import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  modelSelectionSchema,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import { DuoLaunchCoordinator } from "../../src/server/runtime/duo/duo-launch-coordinator";
import type { TurnController } from "../../src/server/runtime/turns/turn-controller";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];

function initializeRepository(path: string, branch: string): void {
  mkdirSync(path);
  execFileSync("git", ["init", "-b", branch, path]);
  writeFileSync(join(path, "tracked.txt"), `${branch}\n`);
  execFileSync("git", ["-C", path, "add", "tracked.txt"]);
  execFileSync("git", [
    "-C", path,
    "-c", "user.name=Inertia Test",
    "-c", "user.email=inertia@example.invalid",
    "commit", "-m", "initial",
  ]);
}

async function reuseFixture(): Promise<{
  dataDirectory: string;
  projectId: string;
  root: string;
  sentinel: string;
  store: RuntimeStore;
  worktree: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inertia-reuse-authority-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const worktree = join(root, "worktree");
  const dataDirectory = join(root, "data");
  initializeRepository(workspace, "main");
  mkdirSync(dataDirectory);
  execFileSync("git", [
    "-C", workspace, "worktree", "add", "-b", "chat", worktree,
  ]);
  const store = new RuntimeStore(
    join(dataDirectory, "inertia.sqlite"),
    workspace,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject(
    "Reuse authority project",
    workspace,
    await inspectProjectIdentity(workspace),
  );
  store.createConversation(project.id, "Attached source", {
    branch: "chat",
    worktreePath: worktree,
  });
  const outside = join(root, "outside");
  const sentinel = join(outside, "sentinel.txt");
  return {
    dataDirectory,
    projectId: project.id,
    root,
    sentinel,
    store,
    worktree,
  };
}

function replaceWorktree(
  fixture: Awaited<ReturnType<typeof reuseFixture>>,
  replacement: "directory" | "symlink",
): void {
  renameSync(fixture.worktree, join(fixture.root, "original-worktree"));
  const outside = join(fixture.root, "outside");
  if (replacement === "directory") {
    initializeRepository(fixture.worktree, "attacker");
    mkdirSync(outside);
  } else {
    initializeRepository(outside, "attacker");
    symlinkSync(
      outside,
      fixture.worktree,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  writeFileSync(fixture.sentinel, "untouched");
}

function selection(modelId = "gpt-test") {
  return modelSelectionSchema.parse(providerNativeModelSelection({
    providerId: "codex",
    modelId,
    alias: modelId,
    reasoningEffort: "high",
  }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    removeTemporaryDirectory,
  ));
});

describe("attached worktree reuse authority", () => {
  it("waits for every side and comparison preflight before rejecting", async () => {
    let announceSideEntered!: () => void;
    let announceComparisonEntered!: () => void;
    let announceFirstFailure!: () => void;
    let announceSideFinished!: () => void;
    let announceComparisonFinished!: () => void;
    let releaseSide!: () => void;
    let releaseComparison!: () => void;
    const sideEntered = new Promise<void>((resolve) => {
      announceSideEntered = resolve;
    });
    const comparisonEntered = new Promise<void>((resolve) => {
      announceComparisonEntered = resolve;
    });
    const firstFailure = new Promise<void>((resolve) => {
      announceFirstFailure = resolve;
    });
    const sideFinished = new Promise<void>((resolve) => {
      announceSideFinished = resolve;
    });
    const comparisonFinished = new Promise<void>((resolve) => {
      announceComparisonFinished = resolve;
    });
    const sideGate = new Promise<void>((resolve) => {
      releaseSide = resolve;
    });
    const comparisonGate = new Promise<void>((resolve) => {
      releaseComparison = resolve;
    });
    const fixture = await reuseFixture();
    let retrying = false;
    let readinessCalls = 0;
    const launches = new DuoLaunchCoordinator(
      fixture.store,
      { resolveModelRoute: resolveNativeModelRoute },
      {
        validateSelection: (value: unknown) => value,
        readiness: async (value: { modelId: string }) => {
          readinessCalls += 1;
          if (retrying) {
            return { ready: false, message: "retry preflight reached" };
          }
          if (value.modelId === "gated-side") {
            announceSideEntered();
            await sideGate;
            announceSideFinished();
            return { ready: false, message: "gated side rejected" };
          }
          if (value.modelId === "gated-comparison") {
            announceComparisonEntered();
            await comparisonGate;
            announceComparisonFinished();
            return { ready: false, message: "gated comparison rejected" };
          }
          await Promise.all([sideEntered, comparisonEntered]);
          announceFirstFailure();
          return { ready: false, message: "first preflight rejected" };
        },
      } as never,
      {} as TurnController,
      fixture.dataDirectory,
      () => [{ id: "codex", canRun: true }] as never,
    );
    const payload: Parameters<DuoLaunchCoordinator["prepare"]>[0] = {
      launchId: randomUUID(),
      prompt: "Settle every preflight before rejecting.",
      sides: [
        {
          projectId: fixture.projectId,
          title: "First failure",
          modelSelection: selection("first-failure"),
          interactionMode: "plan",
          accessMode: "supervised",
          activate: false,
          useWorktree: false,
        },
        {
          projectId: fixture.projectId,
          title: "Gated side",
          modelSelection: selection("gated-side"),
          interactionMode: "build",
          accessMode: "full",
          activate: false,
          useWorktree: false,
        },
      ],
      comparison: {
        projectId: fixture.projectId,
        title: "Gated comparison",
        modelSelection: selection("gated-comparison"),
        interactionMode: "plan",
        accessMode: "supervised",
        activate: false,
      },
    };
    let preparationSettled = false;
    const preparation = launches.prepare(payload);
    void preparation.then(
      () => { preparationSettled = true; },
      () => { preparationSettled = true; },
    );

    try {
      await firstFailure;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(preparationSettled).toBe(false);
      releaseComparison();
      await comparisonFinished;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(preparationSettled).toBe(false);
      releaseSide();
      await sideFinished;

      await expect(preparation).rejects.toThrow("first preflight rejected");
      expect(fixture.store.findPairedLaunch(payload.launchId)).toBeNull();
      expect(fixture.store.shellSnapshot().conversations).toHaveLength(1);
      const firstAttemptCalls = readinessCalls;
      retrying = true;
      await expect(launches.prepare(payload)).rejects.toThrow(
        "retry preflight reached",
      );
      expect(readinessCalls).toBe(firstAttemptCalls + 3);
      expect(() => fixture.store.removeProject(fixture.projectId)).not.toThrow();
    } finally {
      releaseComparison();
      releaseSide();
      await preparation.catch(() => undefined);
      fixture.store.close();
    }
  });

  it.each(["directory", "symlink"] as const)(
    "rejects a %s replacement through conversation.create",
    async (replacement) => {
      const fixture = await reuseFixture();
      replaceWorktree(fixture, replacement);
      const handler = createConversationCommandHandler({
        store: fixture.store,
        providers: { resolveModelRoute: resolveNativeModelRoute },
        backendProfileController: {
          validateSelection: (value: unknown) => value,
        },
      } as unknown as ConversationCommandDependencies);

      await expect(handler({ readyState: WebSocket.OPEN } as WebSocket, {
        type: "conversation.create",
        requestId: randomUUID(),
        payload: {
          projectId: fixture.projectId,
          title: "Replacement reuse",
          modelSelection: selection(),
          worktreePath: fixture.worktree,
        },
      })).rejects.toThrow(/authorization expired/u);
      expect(fixture.store.shellSnapshot().conversations).toHaveLength(1);
      expect(readFileSync(fixture.sentinel, "utf8")).toBe("untouched");
      fixture.store.close();
    },
  );

  it.each(["directory", "symlink"] as const)(
    "rejects a %s replacement through Duo preparation",
    async (replacement) => {
      const fixture = await reuseFixture();
      replaceWorktree(fixture, replacement);
      const launches = new DuoLaunchCoordinator(
        fixture.store,
        { resolveModelRoute: resolveNativeModelRoute },
        {
          validateSelection: (value: unknown) => value,
          readiness: async () => null,
        } as never,
        {} as TurnController,
        fixture.dataDirectory,
        () => [{ id: "codex", canRun: true }] as never,
      );
      const launchId = randomUUID();

      await expect(launches.prepare({
        launchId,
        prompt: "Do not trust a replaced checkout.",
        sides: [
          {
            projectId: fixture.projectId,
            title: "Replacement reuse",
            modelSelection: selection(),
            interactionMode: "plan",
            accessMode: "supervised",
            activate: false,
            useWorktree: false,
            worktreePath: fixture.worktree,
          },
          {
            projectId: fixture.projectId,
            title: "Ordinary sibling",
            modelSelection: selection(),
            interactionMode: "build",
            accessMode: "full",
            activate: false,
            useWorktree: false,
          },
        ],
      })).rejects.toThrow(/authorization expired/u);
      expect(fixture.store.findPairedLaunch(launchId)).toBeNull();
      expect(readFileSync(fixture.sentinel, "utf8")).toBe("untouched");
      fixture.store.close();
    },
  );
});
