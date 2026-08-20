import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import { WorkspacePathAuthority } from "../../src/server/workspace-path-authority";
import {
  createProjectWorkspaceCommandHandler,
  type ProjectWorkspaceCommandDependencies,
} from "../../src/server/runtime/commands/project-workspace-commands";
import {
  createSourceControlCommandHandler,
  type SourceControlCommandDependencies,
} from "../../src/server/runtime/commands/source-control-commands";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];

interface AuthorityFixture {
  root: string;
  workspace: string;
  databasePath: string;
  store: RuntimeStore;
  projectId: string;
  conversationId: string;
}

async function authorityFixture(): Promise<AuthorityFixture> {
  const root = await mkdtemp(join(tmpdir(), "inertia-path-authority-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  mkdirSync(workspace);
  mkdirSync(data);
  const databasePath = join(data, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject("Authority project", workspace);
  const conversation = store.createConversation(project.id, "Authority chat", {
    providerId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
  });
  return {
    root,
    workspace,
    databasePath,
    store,
    projectId: project.id,
    conversationId: conversation.id,
  };
}

async function worktreeAuthorityFixture(): Promise<AuthorityFixture & {
  worktree: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inertia-worktree-authority-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const worktree = join(root, "worktree");
  const data = join(root, "data");
  mkdirSync(workspace);
  mkdirSync(data);
  execFileSync("git", ["init", "-b", "main", workspace]);
  writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
  execFileSync("git", ["-C", workspace, "add", "tracked.txt"]);
  execFileSync("git", [
    "-C", workspace,
    "-c", "user.name=Inertia Test",
    "-c", "user.email=inertia@example.invalid",
    "commit", "-m", "initial",
  ]);
  execFileSync("git", ["-C", workspace, "worktree", "add", "-b", "chat", worktree]);
  const databasePath = join(data, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace, {
    recoverInterruptedRuns: false,
  });
  const project = store.createProject(
    "Worktree authority project",
    workspace,
    await inspectProjectIdentity(workspace),
  );
  const conversation = store.createConversation(project.id, "Worktree chat", {
    providerId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    branch: "chat",
    worktreePath: worktree,
  });
  return {
    root,
    workspace,
    worktree,
    databasePath,
    store,
    projectId: project.id,
    conversationId: conversation.id,
  };
}

function providerInfo(): ProviderInfo {
  return {
    id: "codex",
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [],
      defaultReasoningEffort: "high",
    }],
  } as unknown as ProviderInfo;
}

function workspaceResolver(store: RuntimeStore) {
  return (projectId: string, conversationId?: string): string => {
    if (!conversationId) return store.projectPath(projectId);
    const conversation = store.conversation(conversationId);
    if (conversation.projectId !== projectId) {
      throw new Error("The conversation does not belong to the project.");
    }
    return store.conversationPath(conversationId);
  };
}

function resetWorkspaceAuthorityMigration(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER conversation_context_packets_discard_source_drafts;
    DROP TABLE agent_context_requests;
    DROP TABLE conversation_context_packets;
    DROP TABLE agent_thread_operations;
    DROP TABLE agent_managed_conversations;
    DROP TABLE provider_run_ownership;
    DROP INDEX agent_turns_provider_run_identity_idx;
    DROP TABLE conversation_path_authorities;
    DROP TABLE project_path_authorities;
    DROP TABLE workspace_path_authority_enrollment;
    DELETE FROM schema_migrations WHERE version >= 53;
  `);
}

function enrollmentCompleted(database: Database.Database): number {
  return (database.prepare(`
    SELECT completed FROM workspace_path_authority_enrollment WHERE id = 1
  `).get() as { completed: number }).completed;
}

function operationHarness(
  fixture: AuthorityFixture,
  markers: Record<"provider" | "terminal" | "action" | "git", string>,
) {
  const providerBoundary = vi.fn((input: { harnessId: string }) => {
    writeFileSync(markers.provider, "touched");
    return input.harnessId;
  });
  const providers = {
    resolveModelRoute: resolveNativeModelRoute,
    harnessIdFor: providerBoundary,
    cancel: () => true,
    isRunning: () => false,
  } as unknown as TurnProviderRuntime;
  const turns = new TurnController(
    fixture.store,
    providers,
    new Map(),
    new Map(),
    new Map(),
    {
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo()],
    },
    { id: randomUUID },
  );
  const workspacePath = workspaceResolver(fixture.store);
  const sourceControlWorkspacePath = (
    projectId: string,
    conversationId?: string,
  ): string => {
    const path = workspacePath(projectId, conversationId);
    writeFileSync(markers.git, "touched");
    return path;
  };
  const projectHandler = createProjectWorkspaceCommandHandler({
    store: fixture.store,
    workspacePath,
    workspaceRuns: {
      startAction: async () => {
        writeFileSync(markers.action, "touched");
      },
    },
    terminals: {
      create: () => {
        writeFileSync(markers.terminal, "touched");
        return randomUUID();
      },
    },
    turns,
    send: () => undefined,
  } as unknown as ProjectWorkspaceCommandDependencies);
  const sourceControlHandler = createSourceControlCommandHandler({
    store: fixture.store,
    workspacePath: sourceControlWorkspacePath,
    workspaceRuns: {
      trackSourceControl: async () => {
        writeFileSync(markers.git, "touched");
        return { status: { branch: "authority-test" } };
      },
    },
    send: () => undefined,
  } as unknown as SourceControlCommandDependencies);
  const socket = { readyState: WebSocket.OPEN } as WebSocket;
  return {
    runProvider: () => {
      const queued = turns.queue({
        conversationId: fixture.conversationId,
        content: "Verify the provider boundary.",
      });
      turns.failBeforeStart(fixture.conversationId, "Test cleanup");
      return queued;
    },
    runTerminal: async () => await projectHandler(socket, {
      type: "terminal.create",
      requestId: randomUUID(),
      payload: {
        projectId: fixture.projectId,
        conversationId: fixture.conversationId,
        cols: 80,
        rows: 24,
      },
    }),
    runAction: async () => await projectHandler(socket, {
      type: "project.action.run",
      requestId: randomUUID(),
      payload: {
        projectId: fixture.projectId,
        conversationId: fixture.conversationId,
        actionId: "test",
        cols: 80,
        rows: 24,
      },
    }),
    runGit: async () => await sourceControlHandler(socket, {
      type: "git.refresh",
      requestId: randomUUID(),
      payload: {
        projectId: fixture.projectId,
        conversationId: fixture.conversationId,
      },
    }),
  };
}

async function expectOperationsBlocked(
  fixture: AuthorityFixture,
  replacement: string,
): Promise<void> {
  const markers = Object.fromEntries(
    ["provider", "terminal", "action", "git"].map((kind) => {
      const path = join(replacement, `${kind}.sentinel`);
      writeFileSync(path, "untouched");
      return [kind, path];
    }),
  ) as Record<"provider" | "terminal" | "action" | "git", string>;
  const operations = operationHarness(fixture, markers);
  expect(operations.runProvider).toThrow(/authorization expired/u);
  await expect(operations.runTerminal()).rejects.toThrow(/authorization expired/u);
  await expect(operations.runAction()).rejects.toThrow(/authorization expired/u);
  await expect(operations.runGit()).rejects.toThrow(/authorization expired/u);
  for (const marker of Object.values(markers)) {
    expect(readFileSync(marker, "utf8")).toBe("untouched");
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("durable workspace path authority", () => {
  it("allows the enrolled identity through provider, terminal, action, and Git boundaries", async () => {
    const fixture = await authorityFixture();
    const markerDirectory = join(fixture.root, "markers");
    mkdirSync(markerDirectory);
    const markers = Object.fromEntries(
      ["provider", "terminal", "action", "git"].map((kind) => [
        kind,
        join(markerDirectory, `${kind}.sentinel`),
      ]),
    ) as Record<"provider" | "terminal" | "action" | "git", string>;
    const operations = operationHarness(fixture, markers);

    expect(operations.runProvider().turn.conversationId)
      .toBe(fixture.conversationId);
    await operations.runTerminal();
    await operations.runAction();
    await operations.runGit();

    for (const marker of Object.values(markers)) {
      expect(readFileSync(marker, "utf8")).toBe("touched");
    }
    fixture.store.close();
  });

  it("blocks every privileged boundary after a new directory replaces the enrolled path", async () => {
    const fixture = await authorityFixture();
    renameSync(fixture.workspace, join(fixture.root, "original"));
    mkdirSync(fixture.workspace);
    await expectOperationsBlocked(fixture, fixture.workspace);
    fixture.store.close();
  });

  it("blocks every privileged boundary and preserves an outside sentinel after symlink replacement", async () => {
    const fixture = await authorityFixture();
    const outside = join(fixture.root, "outside");
    renameSync(fixture.workspace, join(fixture.root, "original"));
    mkdirSync(outside);
    symlinkSync(
      outside,
      fixture.workspace,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expectOperationsBlocked(fixture, outside);
    fixture.store.close();
  });

  it("blocks every privileged boundary after a conversation worktree is replaced", async () => {
    const fixture = await worktreeAuthorityFixture();
    renameSync(fixture.worktree, join(fixture.root, "original-worktree"));
    mkdirSync(fixture.worktree);
    await expectOperationsBlocked(fixture, fixture.worktree);
    fixture.store.close();
  });

  it("rolls back new project and external-worktree rows when identity capture fails", async () => {
    const fixture = await authorityFixture();
    const missingProject = join(fixture.root, "missing-project");
    expect(() => fixture.store.createProject("Missing", missingProject))
      .toThrow();
    expect(fixture.store.shellSnapshot().projects).toHaveLength(1);

    const missingWorktree = join(fixture.root, "missing-worktree");
    expect(() => fixture.store.createConversation(
      fixture.projectId,
      "Missing worktree",
      { worktreePath: missingWorktree },
    )).toThrow();
    expect(fixture.store.shellSnapshot().conversations).toHaveLength(1);
    fixture.store.close();
  });

  it("promotes null Git metadata only while the enrolled directory is unchanged", async () => {
    const fixture = await authorityFixture();
    execFileSync("git", ["init", "-b", "main", fixture.workspace]);
    const identity = await inspectProjectIdentity(fixture.workspace);
    fixture.store.updateProject(fixture.projectId, identity);
    expect(fixture.store.projectPath(fixture.projectId)).toBe(fixture.workspace);

    renameSync(join(fixture.workspace, ".git"), join(fixture.workspace, ".git-old"));
    mkdirSync(join(fixture.workspace, ".git"));
    expect(() => fixture.store.projectPath(fixture.projectId))
      .toThrow(/authorization expired/u);
    fixture.store.close();
  });

  it("does not re-enroll an unavailable legacy path during the v52-to-v53 upgrade", async () => {
    const fixture = await authorityFixture();
    fixture.store.close();
    const database = new Database(fixture.databasePath);
    resetWorkspaceAuthorityMigration(database);
    database.close();
    renameSync(fixture.workspace, join(fixture.root, "unavailable"));

    const reopened = new RuntimeStore(fixture.databasePath, fixture.workspace, {
      recoverInterruptedRuns: false,
    });
    expect(() => reopened.projectPath(fixture.projectId))
      .toThrow(/authorization expired/u);
    const inspector = new Database(fixture.databasePath, { readonly: true });
    expect((inspector.prepare(
      "SELECT COUNT(*) AS count FROM project_path_authorities",
    ).get() as { count: number }).count).toBe(0);
    expect(enrollmentCompleted(inspector)).toBe(1);
    inspector.close();
    reopened.close();
  });

  it("resumes legacy enrollment after a crash immediately after v53 commits", async () => {
    const fixture = await authorityFixture();
    fixture.store.close();
    const database = new Database(fixture.databasePath);
    resetWorkspaceAuthorityMigration(database);
    migrateRuntimeDatabase(database);
    expect(enrollmentCompleted(database)).toBe(0);
    database.close();

    const reopened = new RuntimeStore(fixture.databasePath, fixture.workspace, {
      recoverInterruptedRuns: false,
    });
    expect(reopened.projectPath(fixture.projectId)).toBe(fixture.workspace);
    const inspector = new Database(fixture.databasePath, { readonly: true });
    expect(enrollmentCompleted(inspector)).toBe(1);
    inspector.close();
    reopened.close();
  });

  it("idempotently resumes after only part of legacy enrollment was persisted", async () => {
    const fixture = await authorityFixture();
    const secondWorkspace = join(fixture.root, "second-workspace");
    mkdirSync(secondWorkspace);
    const secondProject = fixture.store.createProject("Second", secondWorkspace);
    fixture.store.close();
    const database = new Database(fixture.databasePath);
    resetWorkspaceAuthorityMigration(database);
    migrateRuntimeDatabase(database);
    new WorkspacePathAuthority(database).enrollProject(
      fixture.projectId,
      fixture.workspace,
      null,
      null,
    );
    expect(enrollmentCompleted(database)).toBe(0);
    database.close();

    const reopened = new RuntimeStore(fixture.databasePath, fixture.workspace, {
      recoverInterruptedRuns: false,
    });
    expect(reopened.projectPath(fixture.projectId)).toBe(fixture.workspace);
    expect(reopened.projectPath(secondProject.id)).toBe(secondWorkspace);
    const inspector = new Database(fixture.databasePath, { readonly: true });
    expect((inspector.prepare(
      "SELECT COUNT(*) AS count FROM project_path_authorities",
    ).get() as { count: number }).count).toBe(2);
    expect(enrollmentCompleted(inspector)).toBe(1);
    inspector.close();
    reopened.close();
  });
});
