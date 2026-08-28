import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  WorkspaceRunController,
  workspaceActionKind,
  workspaceServicePort,
  type ReviewedCommitRecovery,
  type SourceControlSerializationIdentityResolver,
  type WorkspaceActionTerminalManager,
} from "../../src/server/runtime/workspace-run-controller";

class FakeTerminals implements WorkspaceActionTerminalManager<object> {
  readonly inputs: Array<{ terminalId: string; data: string }> = [];
  readonly closedManagedIds: string[] = [];
  failReplace = false;
  failInput = false;
  closeManagedFailure: Error | null = null;
  distinctReplacementId: string | null = null;
  private sequence = 0;
  private readonly sessions = new Map<string, {
    onExit?: (exitCode: number) => void;
    onOutput?: (data: string) => void;
  }>();

  create(
    _owner: object,
    _cwd: string,
    _cols: number,
    _rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
  ): string {
    const terminalId = `terminal-${++this.sequence}`;
    this.sessions.set(terminalId, { onExit, onOutput });
    return terminalId;
  }

  async replace(
    _owner: object,
    terminalId: string,
    _cwd: string,
    _cols: number,
    _rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
  ): Promise<string> {
    if (!this.sessions.has(terminalId)) throw new Error("Terminal not found.");
    if (this.failReplace) throw new Error("spawn failed");
    const replacementId = this.distinctReplacementId ?? terminalId;
    this.sessions.set(replacementId, { onExit, onOutput });
    return replacementId;
  }

  input(_owner: object, terminalId: string, data: string): void {
    if (!this.sessions.has(terminalId)) throw new Error("Terminal not found.");
    if (this.failInput) throw new Error("initial input failed");
    this.inputs.push({ terminalId, data });
  }

  async close(_owner: object, terminalId: string): Promise<void> {
    this.finish(terminalId, 130);
  }

  async closeManaged(terminalId: string): Promise<boolean> {
    if (!this.sessions.has(terminalId)) return false;
    if (this.closeManagedFailure) throw this.closeManagedFailure;
    this.closedManagedIds.push(terminalId);
    this.finish(terminalId, 130);
    return true;
  }

  has(terminalId: string): boolean {
    return this.sessions.has(terminalId);
  }

  output(terminalId: string, data: string): void {
    this.sessions.get(terminalId)?.onOutput?.(data);
  }

  finish(terminalId: string, exitCode: number): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
    session.onExit?.(exitCode);
  }
}

const temporaryDirectories: string[] = [];

async function fixture(
  serializationIdentity?: SourceControlSerializationIdentityResolver,
  recoverReviewedCommit: ReviewedCommitRecovery = async () => undefined,
) {
  const root = await mkdtemp(join(tmpdir(), "inertia-workspace-runs-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "workspace-run-controller-fixture",
    private: true,
    scripts: {
      check: "node --check index.js",
      preview: "node preview.js",
    },
  }));
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace);
  const project = store.createProject("Workspace", workspace);
  const conversation = store.createConversation(project.id, "Focused work");
  const terminals = new FakeTerminals();
  const terminalOwner = {};
  const terminalId = terminals.create(terminalOwner, workspace, 80, 24);
  const broadcastSnapshot = vi.fn();
  const broadcastGitInvalidated = vi.fn();
  const controller = new WorkspaceRunController(
    store,
    terminals,
    broadcastSnapshot,
    () => false,
    broadcastGitInvalidated,
    serializationIdentity,
    recoverReviewedCommit,
  );
  return {
    root,
    workspace,
    store,
    project,
    conversation,
    terminals,
    terminalOwner,
    terminalId,
    broadcastSnapshot,
    broadcastGitInvalidated,
    controller,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("workspace run controller", () => {
  it("classifies checks and services and extracts safe local service ports", () => {
    expect(workspaceActionKind("test", "vitest run", false)).toBe("check");
    expect(workspaceActionKind("web", "vite dev", false)).toBe("service");
    expect(workspaceActionKind("custom", "node app.js", true)).toBe("service");
    expect(workspaceServicePort("\u001b[32mLocal: http://localhost:4173/\u001b[0m")).toBe(4173);
    expect(workspaceServicePort("Listening at http://127.0.0.1:70000")).toBeNull();
    expect(workspaceServicePort("Listening without a local URL")).toBeNull();
  });

  it("blocks project actions and Git mutations while a terminal owns the conversation", async () => {
    const runtime = await fixture();
    try {
      const sibling = runtime.store.createConversation(
        runtime.project.id,
        "Sibling chat in the same checkout",
      );
      expect(runtime.store.conversationWork.reserve(runtime.conversation.id)).toBe(true);
      await expect(runtime.controller.startAction({
        owner: runtime.terminalOwner,
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        conversationId: sibling.id,
        actionId: "check",
        terminalId: runtime.terminalId,
        cols: 80,
        rows: 24,
        onStarted: vi.fn(),
      })).rejects.toThrow("End the resumed provider terminal");
      await expect(runtime.controller.startAction({
        owner: runtime.terminalOwner,
        cwd: runtime.workspace,
        projectId: "duplicate-project-record",
        actionId: "check",
        terminalId: runtime.terminalId,
        cols: 80,
        rows: 24,
        onStarted: vi.fn(),
      })).rejects.toThrow("End the resumed provider terminal");
      await expect(runtime.controller.trackSourceControl(
        "Commit changes",
        runtime.project.id,
        sibling.id,
        runtime.workspace,
        "55555555-5555-4555-8555-555555555555",
        async () => "commit-id",
      )).rejects.toThrow("End the resumed provider terminal");
      await expect(runtime.controller.trackSourceControl(
        "Switch branch",
        "duplicate-project-record",
        undefined,
        runtime.workspace,
        "66666666-6666-4666-8666-666666666666",
        async () => "main",
      )).rejects.toThrow("End the resumed provider terminal");
      expect(runtime.terminals.inputs).toEqual([]);
      expect(runtime.store.shellSnapshot().runs).toEqual([]);
    } finally {
      runtime.store.conversationWork.release(runtime.conversation.id);
      runtime.store.close();
    }
  });

  it("holds checkout authority while project actions and Git mutations are active", async () => {
    const runtime = await fixture();
    try {
      const sibling = runtime.store.createConversation(
        runtime.project.id,
        "Sibling chat in the same checkout",
      );
      const terminalId = await runtime.controller.startAction({
        owner: runtime.terminalOwner,
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        actionId: "check",
        terminalId: runtime.terminalId,
        cols: 80,
        rows: 24,
        onStarted: vi.fn(),
      });
      expect(runtime.store.conversationWork.reserve(sibling.id)).toBe(false);
      runtime.terminals.finish(terminalId, 0);
      expect(runtime.store.conversationWork.reserve(sibling.id)).toBe(true);
      runtime.store.conversationWork.release(sibling.id);

      let finishGit!: () => void;
      const gitGate = new Promise<void>((resolve) => {
        finishGit = resolve;
      });
      let gitStarted = false;
      const gitOperation = runtime.controller.trackSourceControl(
        "Switch branch",
        runtime.project.id,
        undefined,
        runtime.workspace,
        "77777777-7777-4777-8777-777777777777",
        async () => {
          gitStarted = true;
          await gitGate;
        },
      );
      await vi.waitFor(() => expect(gitStarted).toBe(true));
      expect(runtime.store.conversationWork.reserve(sibling.id)).toBe(false);
      finishGit();
      await gitOperation;
      expect(runtime.store.conversationWork.reserve(sibling.id)).toBe(true);
      runtime.store.conversationWork.release(sibling.id);
    } finally {
      runtime.store.close();
    }
  });

  it("owns action discovery, process identity, port updates, and stop transitions", async () => {
    const runtime = await fixture();
    try {
      await expect(runtime.controller.listActions(runtime.workspace)).resolves.toEqual([
        {
          id: "check",
          label: "check",
          command: "node --check index.js",
          preview: false,
        },
        {
          id: "preview",
          label: "preview",
          command: "node preview.js",
          preview: true,
        },
      ]);

      const onStarted = vi.fn();
      const terminalId = await runtime.controller.startAction({
        owner: runtime.terminalOwner,
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        conversationId: runtime.conversation.id,
        actionId: "preview",
        terminalId: runtime.terminalId,
        cols: 80,
        rows: 24,
        onStarted,
      });
      expect(terminalId).toBe(runtime.terminalId);
      const running = runtime.store.shellSnapshot().runs.find((run) => run.actionId === "preview")!;
      expect(running).toMatchObject({
        kind: "service",
        status: "running",
        detail: "Codex · Focused work",
      });
      expect(runtime.controller.canStopManagedAction(running)).toBe(true);
      expect(runtime.terminals.inputs).toEqual([
        { terminalId, data: "npm run preview\r" },
      ]);
      expect(onStarted).toHaveBeenCalledWith(terminalId);

      runtime.terminals.output(terminalId, "ready at \u001b[36mhttp://localhost:45678\u001b[0m");
      expect(runtime.store.workspaceRun(running.id).port).toBe(45678);
      await expect(
        runtime.controller.stopManagedAction(running.id),
      ).resolves.toBe(true);
      expect(runtime.store.workspaceRun(running.id)).toMatchObject({
        status: "cancelled",
        detail: "Stopped",
      });
      expect(runtime.controller.canStopManagedAction(runtime.store.workspaceRun(running.id))).toBe(false);
      await expect(
        runtime.controller.stopManagedAction(running.id),
      ).resolves.toBe(false);
      expect(runtime.broadcastSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      runtime.store.close();
    }
  });

  it("uses an authoritative distinct replacement ID without touching the original shell", async () => {
    const runtime = await fixture();
    try {
      const replacementId = "terminal-darwin-action";
      runtime.terminals.distinctReplacementId = replacementId;
      const onStarted = vi.fn();

      await expect(runtime.controller.startAction({
        owner: runtime.terminalOwner,
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        conversationId: runtime.conversation.id,
        actionId: "preview",
        terminalId: runtime.terminalId,
        cols: 80,
        rows: 24,
        onStarted,
      })).resolves.toBe(replacementId);

      expect(runtime.terminals.inputs).toEqual([
        { terminalId: replacementId, data: "npm run preview\r" },
      ]);
      expect(onStarted).toHaveBeenCalledWith(replacementId);
      expect(runtime.terminals.has(runtime.terminalId)).toBe(true);
      const running = runtime.store.shellSnapshot().runs.find(
        (run) => run.actionId === "preview",
      )!;
      await expect(runtime.controller.stopManagedAction(running.id)).resolves.toBe(true);
      expect(runtime.terminals.closedManagedIds).toEqual([replacementId]);
      expect(runtime.terminals.has(runtime.terminalId)).toBe(true);
    } finally {
      runtime.store.close();
    }
  });

  it("retains managed action control when terminal shutdown is unconfirmed", async () => {
    const runtime = await fixture();
    try {
      await runtime.controller.startAction({
        owner: runtime.terminalOwner,
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        conversationId: runtime.conversation.id,
        actionId: "preview",
        terminalId: runtime.terminalId,
        cols: 80,
        rows: 24,
        onStarted: vi.fn(),
      });
      const running = runtime.store.shellSnapshot().runs.find(
        (run) => run.actionId === "preview",
      )!;
      runtime.terminals.closeManagedFailure = new Error(
        "process tree still running",
      );

      await expect(
        runtime.controller.stopManagedAction(running.id),
      ).rejects.toThrow("process tree still running");
      expect(runtime.store.workspaceRun(running.id)).toMatchObject({
        status: "running",
      });
      expect(
        runtime.controller.canStopManagedAction(
          runtime.store.workspaceRun(running.id),
        ),
      ).toBe(true);

      runtime.terminals.closeManagedFailure = null;
      await expect(
        runtime.controller.stopManagedAction(running.id),
      ).resolves.toBe(true);
      expect(runtime.store.workspaceRun(running.id)).toMatchObject({
        status: "cancelled",
        detail: "Stopped",
      });
      expect(
        runtime.controller.canStopManagedAction(
          runtime.store.workspaceRun(running.id),
        ),
      ).toBe(false);
    } finally {
      runtime.store.close();
    }
  });

  it("tracks source-control success and failure as durable workspace activity", async () => {
    const runtime = await fixture();
    try {
      await expect(runtime.controller.trackSourceControl(
        "Commit changes",
        runtime.project.id,
        runtime.conversation.id,
        runtime.workspace,
        "11111111-1111-4111-8111-111111111111",
        async () => "commit-id",
      )).resolves.toBe("commit-id");
      await expect(runtime.controller.trackSourceControl(
        "Push branch",
        runtime.project.id,
        undefined,
        runtime.workspace,
        "22222222-2222-4222-8222-222222222222",
        async () => {
          throw new Error("remote unavailable");
        },
      )).rejects.toThrow("remote unavailable");

      const runs = runtime.store.shellSnapshot().runs;
      expect(runs.find((run) => run.label === "Commit changes")).toMatchObject({
        detail: "Codex · Focused work",
        status: "succeeded",
      });
      expect(runs.find((run) => run.label === "Push branch")).toMatchObject({
        detail: "The request could not be completed.",
        status: "failed",
      });
      expect(runtime.broadcastSnapshot).toHaveBeenCalledTimes(4);
      expect(runtime.broadcastGitInvalidated.mock.calls).toEqual([
        [
          "11111111-1111-4111-8111-111111111111",
          runtime.project.id,
          runtime.conversation.id,
        ],
        [
          "22222222-2222-4222-8222-222222222222",
          runtime.project.id,
          null,
        ],
      ]);
    } finally {
      runtime.store.close();
    }
  });

  it("preserves successful Git results when activity projections fail and releases in-flight state", async () => {
    const runtime = await fixture();
    const updateWorkspaceRun = runtime.store.updateWorkspaceRun.bind(runtime.store);
    let rejectSucceededUpdate = true;
    vi.spyOn(runtime.store, "updateWorkspaceRun").mockImplementation(
      (runId, input) => {
        if (rejectSucceededUpdate && input.status === "succeeded") {
          rejectSucceededUpdate = false;
          throw new Error("Injected activity persistence failure.");
        }
        return updateWorkspaceRun(runId, input);
      },
    );
    runtime.broadcastSnapshot.mockImplementation(() => {
      throw new Error("Injected snapshot broadcast failure.");
    });
    runtime.broadcastGitInvalidated.mockImplementationOnce(() => {
      throw new Error("Injected invalidation broadcast failure.");
    });
    try {
      await expect(runtime.controller.trackSourceControl(
        "Commit changes",
        runtime.project.id,
        runtime.conversation.id,
        runtime.workspace,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        async () => "first-commit",
      )).resolves.toBe("first-commit");

      runtime.broadcastSnapshot.mockImplementation(() => undefined);
      runtime.broadcastGitInvalidated.mockImplementation(() => undefined);
      await expect(runtime.controller.trackSourceControl(
        "Commit follow-up",
        runtime.project.id,
        runtime.conversation.id,
        runtime.workspace,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        async () => "second-commit",
      )).resolves.toBe("second-commit");

      expect(runtime.broadcastGitInvalidated).toHaveBeenCalledTimes(2);
      expect(runtime.store.shellSnapshot().runs.find(
        (run) => run.label === "Commit follow-up",
      )).toMatchObject({ status: "succeeded" });
    } finally {
      runtime.store.close();
    }
  });

  it("serializes Git mutations and publishes each authoritative result", async () => {
    const runtime = await fixture();
    try {
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      const started: string[] = [];
      const first = runtime.controller.trackSourceControl(
        "Switch first branch",
        runtime.project.id,
        runtime.conversation.id,
        runtime.workspace,
        "33333333-3333-4333-8333-333333333333",
        async () => {
          started.push("first");
          await firstGate;
        },
      );
      const second = runtime.controller.trackSourceControl(
        "Switch final branch",
        runtime.project.id,
        runtime.conversation.id,
        runtime.workspace,
        "44444444-4444-4444-8444-444444444444",
        async () => {
          started.push("second");
          await secondGate;
        },
      );

      await vi.waitFor(() => expect(started).toEqual(["first"]));
      finishFirst();
      await first;
      expect(runtime.broadcastGitInvalidated).toHaveBeenCalledTimes(1);
      expect(runtime.broadcastGitInvalidated).toHaveBeenLastCalledWith(
        "33333333-3333-4333-8333-333333333333",
        runtime.project.id,
        runtime.conversation.id,
      );

      await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
      finishSecond();
      await second;
      expect(runtime.broadcastGitInvalidated).toHaveBeenCalledTimes(2);
      expect(runtime.broadcastGitInvalidated).toHaveBeenLastCalledWith(
        "44444444-4444-4444-8444-444444444444",
        runtime.project.id,
        runtime.conversation.id,
      );
    } finally {
      runtime.store.close();
    }
  });

  it("rejects queued metadata replacement before recovery touches it", async () => {
    const recover = vi.fn(async (root: string) => {
      await rm(join(root, ".git", "index.lock"), { force: true });
      await rm(
        join(root, ".git", "index.inertia-commit-transaction.json"),
        { force: true },
      );
    });
    const runtime = await fixture(undefined, recover);
    const gitPath = join(runtime.workspace, ".git");
    const retainedGitPath = join(runtime.workspace, ".git-retained");
    const replacementGitPath = join(runtime.workspace, ".git-replacement");
    await mkdir(gitPath);
    const expected = await stat(gitPath, { bigint: true });
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let firstStarted = false;
    const first = runtime.controller.trackSourceControl(
      "Hold repository queue",
      runtime.project.id,
      runtime.conversation.id,
      runtime.workspace,
      "99999999-9999-4999-8999-999999999999",
      async () => {
        firstStarted = true;
        await firstGate;
      },
      {
        recoverReviewedCommit: true,
        serializationRoot: runtime.workspace,
        verifyRepositoryIdentity: async () => undefined,
      },
    );
    await vi.waitFor(() => expect(firstStarted).toBe(true));

    let secondRan = false;
    const second = runtime.controller.trackSourceControl(
      "Reject replacement repository",
      runtime.project.id,
      runtime.conversation.id,
      runtime.workspace,
      "88888888-8888-4888-8888-888888888888",
      async () => {
        secondRan = true;
      },
      {
        recoverReviewedCommit: true,
        serializationRoot: runtime.workspace,
        verifyRepositoryIdentity: async () => {
          const current = await stat(gitPath, { bigint: true });
          if (current.dev !== expected.dev || current.ino !== expected.ino) {
            throw new Error("Repository metadata identity changed.");
          }
        },
      },
    ).then(() => null, (error: unknown) => error);
    await mkdir(replacementGitPath);
    await writeFile(join(replacementGitPath, "index.lock"), "replacement lock");
    await writeFile(
      join(replacementGitPath, "index.inertia-commit-transaction.json"),
      "replacement journal",
    );
    await rename(gitPath, retainedGitPath);
    await rename(replacementGitPath, gitPath);
    finishFirst();
    await first;

    await expect(second).resolves.toEqual(expect.objectContaining({
      message: "Repository metadata identity changed.",
    }));
    expect(secondRan).toBe(false);
    expect(recover).toHaveBeenCalledOnce();
    await expect(stat(join(gitPath, "index.lock"))).resolves.toBeDefined();
    await expect(stat(join(
      gitPath,
      "index.inertia-commit-transaction.json",
    ))).resolves.toBeDefined();
    runtime.store.close();
  });

  it("serializes nested project roots sharing one repository identity", async () => {
    const runtime = await fixture();
    const nestedWorkspace = join(runtime.workspace, "nested-project");
    await mkdir(nestedWorkspace);
    try {
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      const started: string[] = [];
      const first = runtime.controller.trackSourceControl(
        "Commit repository root",
        runtime.project.id,
        runtime.conversation.id,
        runtime.workspace,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        async () => {
          started.push("root");
          await firstGate;
        },
        { serializationRoot: runtime.workspace },
      );
      const second = runtime.controller.trackSourceControl(
        "Commit nested project",
        runtime.project.id,
        runtime.conversation.id,
        nestedWorkspace,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        async () => {
          started.push("nested");
          await secondGate;
        },
        { serializationRoot: runtime.workspace },
      );

      await vi.waitFor(() => expect(started).toEqual(["root"]));
      finishFirst();
      await first;
      await vi.waitFor(() => expect(started).toEqual(["root", "nested"]));
      finishSecond();
      await second;
    } finally {
      runtime.store.close();
    }
  });

  it("allows distinct repository identities to mutate concurrently", async () => {
    const runtime = await fixture();
    const firstRepository = join(runtime.workspace, "repository-one");
    const secondRepository = join(runtime.workspace, "repository-two");
    await Promise.all([mkdir(firstRepository), mkdir(secondRepository)]);
    try {
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      const started: string[] = [];
      const first = runtime.controller.trackSourceControl(
        "Commit first repository",
        runtime.project.id,
        runtime.conversation.id,
        firstRepository,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        async () => {
          started.push("first");
          await firstGate;
        },
        { serializationRoot: firstRepository },
      );
      const second = runtime.controller.trackSourceControl(
        "Commit second repository",
        runtime.project.id,
        runtime.conversation.id,
        secondRepository,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        async () => {
          started.push("second");
          await secondGate;
        },
        { serializationRoot: secondRepository },
      );

      await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
      finishFirst();
      finishSecond();
      await Promise.all([first, second]);
    } finally {
      runtime.store.close();
    }
  });

  it("serializes distinct aliases that resolve to the same filesystem identity", async () => {
    const sharedIdentity = {
      canonicalPath: "C:/Repo",
      dev: 7n,
      ino: 11n,
      birthtimeNs: 13n,
    };
    const runtime = await fixture(() => sharedIdentity);
    const firstCheckout = join(runtime.workspace, "alias-one");
    const secondCheckout = join(runtime.workspace, "alias-two");
    await Promise.all([mkdir(firstCheckout), mkdir(secondCheckout)]);
    try {
      let finishFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const started: string[] = [];
      const first = runtime.controller.trackSourceControl(
        "Commit first alias",
        runtime.project.id,
        runtime.conversation.id,
        firstCheckout,
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        async () => {
          started.push("first");
          await firstGate;
        },
        { serializationRoot: "C:/Repo" },
      );
      const second = runtime.controller.trackSourceControl(
        "Commit second alias",
        runtime.project.id,
        runtime.conversation.id,
        secondCheckout,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        async () => {
          started.push("second");
        },
        { serializationRoot: "c:/repo" },
      );

      await vi.waitFor(() => expect(started).toEqual(["first"]));
      finishFirst();
      await first;
      await second;
      expect(started).toEqual(["first", "second"]);
    } finally {
      runtime.store.close();
    }
  });

  it("keeps case-distinct roots concurrent when their identities differ", async () => {
    const runtime = await fixture((root) => ({
      canonicalPath: root,
      dev: 7n,
      ino: root === "C:/Repo" ? 17n : 19n,
      birthtimeNs: 23n,
    }));
    const firstCheckout = join(runtime.workspace, "case-upper");
    const secondCheckout = join(runtime.workspace, "case-lower");
    await Promise.all([mkdir(firstCheckout), mkdir(secondCheckout)]);
    try {
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      const started: string[] = [];
      const first = runtime.controller.trackSourceControl(
        "Commit case-sensitive upper root",
        runtime.project.id,
        runtime.conversation.id,
        firstCheckout,
        "11111111-aaaa-4111-8111-aaaaaaaaaaaa",
        async () => {
          started.push("upper");
          await firstGate;
        },
        { serializationRoot: "C:/Repo" },
      );
      const second = runtime.controller.trackSourceControl(
        "Commit case-sensitive lower root",
        runtime.project.id,
        runtime.conversation.id,
        secondCheckout,
        "22222222-bbbb-4222-8222-bbbbbbbbbbbb",
        async () => {
          started.push("lower");
          await secondGate;
        },
        { serializationRoot: "C:/repo" },
      );

      await vi.waitFor(() => expect(started).toEqual(["upper", "lower"]));
      finishFirst();
      finishSecond();
      await Promise.all([first, second]);
    } finally {
      runtime.store.close();
    }
  });

  it.each(["replace", "input"] as const)(
    "settles an action when terminal %s fails without retaining stop ownership",
    async (failure) => {
      const runtime = await fixture();
      try {
        runtime.terminals.failReplace = failure === "replace";
        runtime.terminals.failInput = failure === "input";
        await expect(runtime.controller.startAction({
          owner: runtime.terminalOwner,
          cwd: runtime.workspace,
          projectId: runtime.project.id,
          conversationId: runtime.conversation.id,
          actionId: "check",
          terminalId: runtime.terminalId,
          cols: 80,
          rows: 24,
          onStarted: vi.fn(),
        })).rejects.toThrow(failure === "replace" ? "spawn failed" : "initial input failed");

        const failed = runtime.store.shellSnapshot().runs.find((run) => run.actionId === "check")!;
        expect(failed).toMatchObject({
          status: "failed",
          detail: "The request could not be completed.",
          finishedAt: expect.any(String),
        });
        expect(runtime.controller.canStopManagedAction(failed)).toBe(false);
        await expect(
          runtime.controller.stopManagedAction(failed.id),
        ).resolves.toBe(false);
        expect(runtime.broadcastSnapshot).toHaveBeenCalledTimes(1);
      } finally {
        runtime.store.close();
      }
    },
  );
});
