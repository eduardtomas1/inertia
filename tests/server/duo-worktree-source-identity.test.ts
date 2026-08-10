import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import type {
  GitRepositoryStatus,
  OwnedWorktreeCreationHooks,
} from "../../src/server/git";
import {
  DuoLaunchCoordinator,
  type DuoWorktreeOperations,
} from "../../src/server/runtime/duo/duo-launch-coordinator";
import { resolveNativeModelRoute } from "./model-route-fixture";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const ownedHead = "a".repeat(40);
const repositoryIdentity = "b".repeat(64);
const filesystemReceipt = {
  version: 1,
  worktreesDirectory: { device: "1", inode: "2", birthtimeNs: "3" },
  adminDirectory: { device: "1", inode: "4", birthtimeNs: "5" },
} as const;

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

function acknowledge(
  hooks: OwnedWorktreeCreationHooks,
  path: string,
  branch: string,
): void {
  const ownershipToken = randomUUID();
  hooks.beforeAdd(ownershipToken);
  hooks.added({
    path,
    branch,
    head: ownedHead,
    worktreeId: `test-${ownershipToken}`,
    repositoryIdentity,
    ownershipToken,
    filesystemReceipt,
  });
}

function status(root: string, branch: string): GitRepositoryStatus {
  return {
    root,
    branch,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    pullRequest: {
      available: false,
      remoteName: null,
      forge: null,
      unavailableReason: "no-remotes",
    },
    files: [],
    insertions: 0,
    deletions: 0,
    clean: true,
    truncated: false,
  };
}

function worktrees(
  overrides: Partial<DuoWorktreeOperations> = {},
): DuoWorktreeOperations {
  return {
    preflightFilesystem: async () => undefined,
    create: async (_repositoryPath, worktreePath, options, hooks) => {
      acknowledge(hooks, worktreePath, options.branch);
      return status(worktreePath, options.branch);
    },
    inspectCreatingWorktree: async () => "retained",
    inspectWorktree: async () => ({ state: "absent" }),
    inspectBranch: async () => "absent",
    ...overrides,
  };
}

async function runtime(): Promise<{
  dataDirectory: string;
  linked: {
    gitDirectory: string;
    replacement: string;
    replacementCommonDirectory: string;
    source: string;
  };
  projectId: string;
  store: RuntimeStore;
  workspace: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-duo-source-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  const linked = await replaceableLinkedWorkspace(workspace);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspace, {
    recoverInterruptedRuns: false,
  });
  return {
    dataDirectory: join(directory, "data"),
    linked,
    projectId: store.createProject("Duo project", workspace).id,
    store,
    workspace,
  };
}

async function replaceableLinkedWorkspace(workspace: string): Promise<{
  gitDirectory: string;
  replacement: string;
  replacementCommonDirectory: string;
  source: string;
}> {
  const source = join(workspace, "..", "source");
  const replacement = join(workspace, "..", "replacement");
  await rm(workspace, { recursive: true, force: true });
  await mkdir(source);
  await mkdir(replacement);
  await execFileAsync("git", ["init", "-q", "--initial-branch=main", source]);
  await execFileAsync("git", [
    "-C", source,
    "-c", "user.name=Inertia Tests",
    "-c", "user.email=tests@inertia.invalid",
    "commit", "--allow-empty", "-m", "Initial",
  ]);
  await execFileAsync("git", [
    "-C", source, "worktree", "add", "-q", "-b", "linked", workspace,
  ]);
  await execFileAsync("git", [
    "init", "-q", "--initial-branch=main", replacement,
  ]);
  await execFileAsync("git", [
    "-C", replacement,
    "-c", "user.name=Inertia Tests",
    "-c", "user.email=tests@inertia.invalid",
    "commit", "--allow-empty", "-m", "Replacement",
  ]);
  const inspect = (...args: string[]) => execFileSync("git", args, {
    encoding: "utf8",
  }).trim();
  return {
    gitDirectory: inspect(
      "-C", workspace, "rev-parse", "--path-format=absolute", "--git-dir",
    ),
    replacement,
    replacementCommonDirectory: inspect(
      "-C", replacement,
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ),
    source,
  };
}

function payload(
  context: Awaited<ReturnType<typeof runtime>>,
): Parameters<DuoLaunchCoordinator["prepare"]>[0] {
  const selection = modelSelectionSchema.parse(nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-test",
    alias: "GPT Test",
    reasoningEffort: "high",
  }));
  return {
    launchId: randomUUID(),
    prompt: "Prepare both sides safely.",
    sides: [
      {
        projectId: context.projectId,
        title: "Isolated side",
        modelSelection: selection,
        interactionMode: "build" as const,
        accessMode: "supervised" as const,
        activate: false,
        useWorktree: true,
      },
      {
        projectId: context.projectId,
        title: "Root side",
        modelSelection: selection,
        interactionMode: "plan" as const,
        accessMode: "supervised" as const,
        activate: false,
        useWorktree: false,
      },
    ],
  };
}

function coordinator(
  context: Awaited<ReturnType<typeof runtime>>,
  operations: DuoWorktreeOperations,
  workspaceRuns?: { trackSourceControl: (...args: never[]) => Promise<unknown> },
): DuoLaunchCoordinator {
  return new DuoLaunchCoordinator(
    context.store,
    { resolveModelRoute: resolveNativeModelRoute },
    {
      validateSelection: (selection: unknown) => selection,
      readiness: async () => null,
    } as never,
    {} as never,
    context.dataDirectory,
    () => [providerInfo()],
    { worktrees: operations, workspaceRuns: workspaceRuns as never },
  );
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("Duo isolated-worktree source identity", () => {
  it("rejects linked-root metadata replacement before launch or mutation", async () => {
    const context = await runtime();
    try {
      const fixture = context.linked;
      const create = vi.fn(worktrees().create);
      const trackSourceControl = vi.fn(async (
        _label: string,
        _projectId: string,
        _conversationId: string | undefined,
        _cwd: string,
        _requestId: string,
        operation: () => Promise<unknown>,
      ) => {
        writeFileSync(
          join(fixture.gitDirectory, "commondir"),
          `${fixture.replacementCommonDirectory}\n`,
        );
        return await operation();
      });
      const input = payload(context);

      await expect(coordinator(
        context,
        worktrees({ create }),
        { trackSourceControl } as never,
      ).prepare(input)).rejects.toThrow(
        /repository changed while its isolated worktree/iu,
      );

      expect(create).not.toHaveBeenCalled();
      expect(context.store.findPairedLaunch(input.launchId)).toBeNull();
      expect(context.store.snapshot().conversations).toEqual([]);
      expect(existsSync(context.dataDirectory)).toBe(false);
      const branches = (repository: string) => execFileSync("git", [
        "-C", repository, "branch", "--list", "inertia/*",
      ], { encoding: "utf8" }).trim();
      expect(branches(fixture.source)).toBe("");
      expect(branches(fixture.replacement)).toBe("");
    } finally {
      context.store.close();
    }
  });

  it("retains recovery ownership after post-create metadata replacement", async () => {
    const context = await runtime();
    try {
      const fixture = context.linked;
      const create = vi.fn(async (
        _repositoryPath: string,
        worktreePath: string,
        options: { branch: string; createBranch: true; startPoint: string },
        hooks: OwnedWorktreeCreationHooks,
      ) => {
        acknowledge(hooks, worktreePath, options.branch);
        writeFileSync(
          join(fixture.gitDirectory, "commondir"),
          `${fixture.replacementCommonDirectory}\n`,
        );
        return status(worktreePath, options.branch);
      });
      const inspectWorktree = vi.fn(async (
        _repositoryPath: string,
        worktreePath: string,
        branch: string,
        head: string,
        worktreeId: string,
        currentRepositoryIdentity: string,
        ownershipToken: string,
      ) => ({
        state: "registered" as const,
        identity: {
          path: worktreePath,
          branch,
          head,
          worktreeId,
          repositoryIdentity: currentRepositoryIdentity,
          ownershipToken,
          filesystemReceipt,
        },
      }));
      const input = payload(context);

      await expect(coordinator(context, worktrees({
        create,
        inspectWorktree,
      })).prepare(input)).rejects.toThrow(
        /repository changed while its isolated worktree/iu,
      );

      expect(create).toHaveBeenCalledOnce();
      expect(inspectWorktree).toHaveBeenCalledOnce();
      expect(context.store.snapshot().conversations).toEqual([]);
      const failed = context.store.pairedLaunch(input.launchId);
      expect(failed).toMatchObject({ state: "recovery-required" });
      expect(failed.plans[0]).toMatchObject({
        worktreeCreationState: "created",
        cleanupBranchHead: ownedHead,
        worktreeCleanupOutcome: "retained",
      });
      expect(failed.error).toContain("structured recovery details");
    } finally {
      context.store.close();
    }
  });
});
