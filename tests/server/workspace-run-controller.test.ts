import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  WorkspaceRunController,
  workspaceActionKind,
  workspaceServicePort,
  type WorkspaceActionTerminalManager,
} from "../../src/server/runtime/workspace-run-controller";

class FakeTerminals implements WorkspaceActionTerminalManager<object> {
  readonly inputs: Array<{ terminalId: string; data: string }> = [];
  failCreate = false;
  failInput = false;
  closeManagedFailure: Error | null = null;
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
    if (this.failCreate) throw new Error("spawn failed");
    const terminalId = `terminal-${++this.sequence}`;
    this.sessions.set(terminalId, { onExit, onOutput });
    return terminalId;
  }

  input(_owner: object, terminalId: string, data: string): void {
    if (!this.sessions.has(terminalId)) throw new Error("Terminal not found.");
    if (this.failInput) throw new Error("initial input failed");
    this.inputs.push({ terminalId, data });
  }

  close(_owner: object, terminalId: string): void {
    this.finish(terminalId, 130);
  }

  async closeManaged(terminalId: string): Promise<boolean> {
    if (!this.sessions.has(terminalId)) return false;
    if (this.closeManagedFailure) throw this.closeManagedFailure;
    this.finish(terminalId, 130);
    return true;
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

async function fixture() {
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
  const broadcastSnapshot = vi.fn();
  const broadcastGitInvalidated = vi.fn();
  const controller = new WorkspaceRunController(
    store,
    terminals,
    broadcastSnapshot,
    () => false,
    broadcastGitInvalidated,
  );
  return {
    root,
    workspace,
    store,
    project,
    conversation,
    terminals,
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
        owner: {},
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        conversationId: sibling.id,
        actionId: "check",
        cols: 80,
        rows: 24,
        onStarted: vi.fn(),
      })).rejects.toThrow("End the resumed provider terminal");
      await expect(runtime.controller.startAction({
        owner: {},
        cwd: runtime.workspace,
        projectId: "duplicate-project-record",
        actionId: "check",
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
        owner: {},
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        actionId: "check",
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
        owner: {},
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        conversationId: runtime.conversation.id,
        actionId: "preview",
        cols: 80,
        rows: 24,
        onStarted,
      });
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

  it("retains managed action control when terminal shutdown is unconfirmed", async () => {
    const runtime = await fixture();
    try {
      await runtime.controller.startAction({
        owner: {},
        cwd: runtime.workspace,
        projectId: runtime.project.id,
        conversationId: runtime.conversation.id,
        actionId: "preview",
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

  it.each(["create", "input"] as const)(
    "settles an action when terminal %s fails without retaining stop ownership",
    async (failure) => {
      const runtime = await fixture();
      try {
        runtime.terminals.failCreate = failure === "create";
        runtime.terminals.failInput = failure === "input";
        await expect(runtime.controller.startAction({
          owner: {},
          cwd: runtime.workspace,
          projectId: runtime.project.id,
          conversationId: runtime.conversation.id,
          actionId: "check",
          cols: 80,
          rows: 24,
          onStarted: vi.fn(),
        })).rejects.toThrow(failure === "create" ? "spawn failed" : "initial input failed");

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
