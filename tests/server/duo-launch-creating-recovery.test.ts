import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { GitError } from "../../src/server/git";
import {
  DuoLaunchCoordinator,
  type DuoWorktreeOperations,
} from "../../src/server/runtime/duo/duo-launch-coordinator";
import type { TurnController } from "../../src/server/runtime/turns/turn-controller";
import { resolveNativeModelRoute } from "./model-route-fixture";

function providerInfo(): ProviderInfo {
  const field = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: "codex",
    label: "Codex",
    command: "fake-codex",
    available: true,
    version: "test",
    executable: "fake-codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      description: "Fake model",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
  };
}

it("reconciles an unacknowledged creation only after manual absence across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inertia-duo-creating-recovery-"));
  const workspace = join(directory, "workspace");
  const databasePath = join(directory, "inertia.sqlite");
  mkdirSync(workspace);
  execFileSync("git", ["init", "-q", "-b", "main", workspace]);
  execFileSync("git", [
    "-C",
    workspace,
    "-c",
    "user.name=Inertia Tests",
    "-c",
    "user.email=tests@inertia.invalid",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "Initial",
  ]);
  let store: RuntimeStore | null = new RuntimeStore(
    databasePath,
    workspace,
    { recoverInterruptedRuns: false },
  );
  const projectId = store.createProject("Duo project", workspace).id;
  let inspection: "absent" | "retained" = "retained";
  const inspectCreatingWorktree = vi.fn(async () => inspection);
  const inspectWorktree = vi.fn(async () => ({ state: "absent" as const }));
  const inspectBranch = vi.fn(async () => "absent" as const);
  const worktrees: DuoWorktreeOperations = {
    preflightFilesystem: async () => undefined,
    create: async (_repositoryPath, _worktreePath, _options, hooks) => {
      hooks.beforeAdd(randomUUID());
      throw new GitError(
        "timeout",
        "worktree add delivery was ambiguous after mutation",
      );
    },
    inspectCreatingWorktree,
    inspectWorktree,
    inspectBranch,
  };
  const turns = {
    cancel: vi.fn(() => false),
    startPair: vi.fn(),
  } as unknown as TurnController;
  const coordinator = (runtimeStore: RuntimeStore) => new DuoLaunchCoordinator(
    runtimeStore,
    { resolveModelRoute: resolveNativeModelRoute },
    {
      validateSelection: (selection: unknown) => selection,
      readiness: async () => null,
    } as never,
    turns,
    join(workspace, ".inertia"),
    () => [providerInfo()],
    { worktrees },
  );
  const launchId = randomUUID();
  const modelSelection = modelSelectionSchema.parse(nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-test",
    alias: "GPT Test",
    reasoningEffort: "high",
  }));
  const payload: Parameters<DuoLaunchCoordinator["prepare"]>[0] = {
    launchId,
    prompt: "Prepare both sides before dispatch.",
    sides: [
      {
        projectId,
        title: "Prepared left",
        modelSelection,
        interactionMode: "plan",
        accessMode: "supervised",
        activate: false,
        useWorktree: true,
      },
      {
        projectId,
        title: "Prepared right",
        modelSelection,
        interactionMode: "build",
        accessMode: "full",
        activate: false,
        useWorktree: false,
      },
    ],
  };

  try {
    const launches = coordinator(store);
    await expect(launches.prepare(payload)).rejects.toThrow(/ambiguous/u);
    await expect(launches.cancel(launchId)).resolves.toMatchObject({
      state: "recovery-required",
    });
    expect(store.pairedLaunch(launchId).plans[0]).toMatchObject({
      worktreeCreationState: "creating",
      cleanupWorktreeToken: expect.any(String),
    });
    expect(inspectCreatingWorktree).toHaveBeenCalledTimes(2);
    expect(inspectWorktree).not.toHaveBeenCalled();
    expect(inspectBranch).not.toHaveBeenCalled();
    expect(() => store?.removeProject(projectId))
      .toThrow(/Cancel the active Duo launch/u);
    store.close();
    store = null;

    inspection = "absent";
    store = new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    await expect(coordinator(store).cancel(launchId)).resolves.toMatchObject({
      state: "cancelled",
    });
    expect(store.pairedLaunch(launchId).plans[0]).toMatchObject({
      worktreeCreationState: "not-created",
      cleanupWorktreeToken: null,
    });
    expect(inspectCreatingWorktree).toHaveBeenCalledTimes(3);
    expect(inspectWorktree).not.toHaveBeenCalled();
    expect(inspectBranch).not.toHaveBeenCalled();
    expect(() => store?.removeProject(projectId)).not.toThrow();
    expect(store.findPairedLaunch(launchId)).toBeNull();
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
