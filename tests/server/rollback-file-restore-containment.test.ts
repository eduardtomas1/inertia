import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  onDeleteCheckpoint: null as null | (() => void),
}));

vi.mock("../../src/server/checkpoints", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/checkpoints")>();
  return {
    ...original,
    deleteCheckpoint: async (...args: Parameters<typeof original.deleteCheckpoint>) => {
      try {
        return await original.deleteCheckpoint(...args);
      } finally {
        hooks.onDeleteCheckpoint?.();
      }
    },
  };
});

import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

const managers: TurnGitArtifactManager[] = [];

afterEach(async () => {
  hooks.onDeleteCheckpoint = null;
  vi.restoreAllMocks();
  for (const manager of managers.splice(0).reverse()) {
    await manager.settleShutdown().catch(() => undefined);
  }
  await cleanupTurnControllerTestDirectories();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("rollback file restore symlink containment", () => {
  it("never unlinks a file outside the project workspace through a symlink that stays inside the Git repo root", async () => {
    let manager!: TurnGitArtifactManager;
    const runtime = await createTurnControllerTestRuntime({
      createTurnCheckpoint: (turn, signal) => manager.createTurnCheckpoint(turn, signal),
      captureGitBefore: (input) => manager.captureBefore(input),
      captureGitArtifacts: (input) => manager.finalize(input),
    });
    manager = new TurnGitArtifactManager(runtime.store, join(runtime.directory, "data"));
    managers.push(manager);

    try {
      const repoRoot = runtime.workspace;
      const appWorkspace = join(repoRoot, "packages", "app");
      const siblingDir = join(repoRoot, "packages", "secret");
      mkdirSync(appWorkspace, { recursive: true });
      mkdirSync(siblingDir, { recursive: true });

      git(repoRoot, "init", "-b", "main");
      git(repoRoot, "config", "core.autocrlf", "false");
      git(repoRoot, "config", "user.name", "Inertia Test");
      git(repoRoot, "config", "user.email", "test@inertia.local");
      writeFileSync(join(appWorkspace, "base.txt"), "base\n");
      writeFileSync(join(siblingDir, "keep.txt"), "do not delete\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-m", "base");

      const subProject = runtime.store.createProject("App Subdir", appWorkspace);
      const subConv = runtime.store.createConversation(subProject.id, "Subdir chat", {
        providerId: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
      });

      const runTurn = async (label: string, write: () => void) => {
        const runs = runtime.provider.runCount;
        const queued = runtime.controller.queue({
          conversationId: subConv.id,
          content: `${label} request`,
          turnCheckpoint: true,
        });
        runtime.controller.start(queued.turn.id);
        await vi.waitFor(() => expect(runtime.provider.runCount).toBe(runs + 1), { timeout: 20_000, interval: 20 });
        write();
        runtime.provider.resolve({ text: `${label} answer`, sessionId: `${label}-sess` });
        await vi.waitFor(() => expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed"), { timeout: 20_000, interval: 20 });
        await vi.waitFor(() => expect(runtime.store.turnGitArtifact(queued.turn.id)?.status).toBe("ready"), { timeout: 20_000, interval: 20 });
        return queued.turn;
      };

      const first = await runTurn("first", () => {
        writeFileSync(join(appWorkspace, "base.txt"), "first\n");
      });
      const second = await runTurn("second", () => {
        mkdirSync(join(appWorkspace, "packages", "app", "nested"), { recursive: true });
        writeFileSync(join(appWorkspace, "packages", "app", "nested", "keep.txt"), "created in turn 2\n");
      });
      void second;

      let deleteCalls = 0;
      hooks.onDeleteCheckpoint = () => {
        deleteCalls += 1;
        if (deleteCalls === 2) {
          rmSync(join(appWorkspace, "packages", "app", "nested"), { recursive: true, force: true });
          symlinkSync(siblingDir, join(appWorkspace, "packages", "app", "nested"));
        }
      };

      const result = await rollbackConversationHistory(
        {
          store: runtime.store,
          turns: runtime.controller,
          providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
          providers: {
            resolveModelRoute: runtime.provider.resolveModelRoute,
            isRunning: (id: string) => runtime.provider.isRunning(id),
            nativeConversation: vi.fn(async (request) => ({
              operationId: request.operationId,
              identity: request.source.identity,
              status: "unsupported" as const,
              reason: "native-history-control-unavailable",
            })),
          },
        },
        {
          conversationId: subConv.id,
          turnId: first.id,
          restoreFiles: true,
          source: {
            actorId: "human",
            commandId: "rollback-symlink-test",
            command: { type: "conversation.rollback", conversationId: subConv.id, turnId: first.id, restoreFiles: true },
          },
        },
        new AbortController().signal,
      );

      expect(result.files.outcome).toBe("restored");
      expect(existsSync(join(siblingDir, "keep.txt"))).toBe(true);
    } finally {
      runtime.store.close();
    }
  }, 60_000);

  it("removes the file a rolled-back turn created in a subdirectory project and keeps the user file at the root-relative path", async () => {
    let manager!: TurnGitArtifactManager;
    const runtime = await createTurnControllerTestRuntime({
      createTurnCheckpoint: (turn, signal) => manager.createTurnCheckpoint(turn, signal),
      captureGitBefore: (input) => manager.captureBefore(input),
      captureGitArtifacts: (input) => manager.finalize(input),
    });
    manager = new TurnGitArtifactManager(runtime.store, join(runtime.directory, "data"));
    managers.push(manager);

    try {
      const repoRoot = runtime.workspace;
      const appWorkspace = join(repoRoot, "packages", "app");
      const siblingDir = join(repoRoot, "packages", "secret");
      mkdirSync(appWorkspace, { recursive: true });
      mkdirSync(siblingDir, { recursive: true });

      git(repoRoot, "init", "-b", "main");
      git(repoRoot, "config", "core.autocrlf", "false");
      git(repoRoot, "config", "user.name", "Inertia Test");
      git(repoRoot, "config", "user.email", "test@inertia.local");
      writeFileSync(join(appWorkspace, "base.txt"), "base\n");
      writeFileSync(join(siblingDir, "keep.txt"), "do not delete\n");
      mkdirSync(join(appWorkspace, "nested"), { recursive: true });
      writeFileSync(join(appWorkspace, "nested", "keep.txt"), "user file\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-m", "base");

      const subProject = runtime.store.createProject("App Subdir", appWorkspace);
      const subConv = runtime.store.createConversation(subProject.id, "Subdir chat", {
        providerId: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
      });

      const runTurn = async (label: string, write: () => void) => {
        const runs = runtime.provider.runCount;
        const queued = runtime.controller.queue({
          conversationId: subConv.id,
          content: `${label} request`,
          turnCheckpoint: true,
        });
        runtime.controller.start(queued.turn.id);
        await vi.waitFor(() => expect(runtime.provider.runCount).toBe(runs + 1), { timeout: 20_000, interval: 20 });
        write();
        runtime.provider.resolve({ text: `${label} answer`, sessionId: `${label}-sess` });
        await vi.waitFor(() => expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed"), { timeout: 20_000, interval: 20 });
        await vi.waitFor(() => expect(runtime.store.turnGitArtifact(queued.turn.id)?.status).toBe("ready"), { timeout: 20_000, interval: 20 });
        return queued.turn;
      };

      const first = await runTurn("first", () => {
        writeFileSync(join(appWorkspace, "base.txt"), "first\n");
      });
      const second = await runTurn("second", () => {
        mkdirSync(join(appWorkspace, "packages", "app", "nested"), { recursive: true });
        writeFileSync(join(appWorkspace, "packages", "app", "nested", "keep.txt"), "created in turn 2\n");
      });
      void second;

      const result = await rollbackConversationHistory(
        {
          store: runtime.store,
          turns: runtime.controller,
          providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
          providers: {
            resolveModelRoute: runtime.provider.resolveModelRoute,
            isRunning: (id: string) => runtime.provider.isRunning(id),
            nativeConversation: vi.fn(async (request) => ({
              operationId: request.operationId,
              identity: request.source.identity,
              status: "unsupported" as const,
              reason: "native-history-control-unavailable",
            })),
          },
        },
        {
          conversationId: subConv.id,
          turnId: first.id,
          restoreFiles: true,
          source: {
            actorId: "human",
            commandId: "rollback-subdirectory-test",
            command: { type: "conversation.rollback", conversationId: subConv.id, turnId: first.id, restoreFiles: true },
          },
        },
        new AbortController().signal,
      );

      expect(result.files.outcome).toBe("restored");
      expect(existsSync(join(appWorkspace, "nested", "keep.txt"))).toBe(true);
      expect(existsSync(join(appWorkspace, "packages", "app", "nested", "keep.txt"))).toBe(false);
    } finally {
      runtime.store.close();
    }
  }, 60_000);

  it("refuses to restore over a staged file a rolled-back turn created in a subdirectory project when the user edited it afterwards", async () => {
    let manager!: TurnGitArtifactManager;
    const runtime = await createTurnControllerTestRuntime({
      createTurnCheckpoint: (turn, signal) => manager.createTurnCheckpoint(turn, signal),
      captureGitBefore: (input) => manager.captureBefore(input),
      captureGitArtifacts: (input) => manager.finalize(input),
    });
    manager = new TurnGitArtifactManager(runtime.store, join(runtime.directory, "data"));
    managers.push(manager);

    try {
      const repoRoot = runtime.workspace;
      const appWorkspace = join(repoRoot, "packages", "app");
      const siblingDir = join(repoRoot, "packages", "secret");
      mkdirSync(appWorkspace, { recursive: true });
      mkdirSync(siblingDir, { recursive: true });

      git(repoRoot, "init", "-b", "main");
      git(repoRoot, "config", "core.autocrlf", "false");
      git(repoRoot, "config", "user.name", "Inertia Test");
      git(repoRoot, "config", "user.email", "test@inertia.local");
      writeFileSync(join(appWorkspace, "base.txt"), "base\n");
      writeFileSync(join(siblingDir, "keep.txt"), "do not delete\n");
      mkdirSync(join(appWorkspace, "nested"), { recursive: true });
      writeFileSync(join(appWorkspace, "nested", "keep.txt"), "user file\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-m", "base");

      const subProject = runtime.store.createProject("App Subdir", appWorkspace);
      const subConv = runtime.store.createConversation(subProject.id, "Subdir chat", {
        providerId: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
      });

      const runTurn = async (label: string, write: () => void) => {
        const runs = runtime.provider.runCount;
        const queued = runtime.controller.queue({
          conversationId: subConv.id,
          content: `${label} request`,
          turnCheckpoint: true,
        });
        runtime.controller.start(queued.turn.id);
        await vi.waitFor(() => expect(runtime.provider.runCount).toBe(runs + 1), { timeout: 20_000, interval: 20 });
        write();
        runtime.provider.resolve({ text: `${label} answer`, sessionId: `${label}-sess` });
        await vi.waitFor(() => expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed"), { timeout: 20_000, interval: 20 });
        await vi.waitFor(() => expect(runtime.store.turnGitArtifact(queued.turn.id)?.status).toBe("ready"), { timeout: 20_000, interval: 20 });
        return queued.turn;
      };

      const first = await runTurn("first", () => {
        writeFileSync(join(appWorkspace, "base.txt"), "first\n");
      });
      await runTurn("second", () => {
        writeFileSync(join(appWorkspace, "staged.txt"), "from turn\n");
        git(appWorkspace, "add", "staged.txt");
      });
      writeFileSync(join(appWorkspace, "staged.txt"), "user edit after the turn\n");

      const result = await rollbackConversationHistory(
        {
          store: runtime.store,
          turns: runtime.controller,
          providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
          providers: {
            resolveModelRoute: runtime.provider.resolveModelRoute,
            isRunning: (id: string) => runtime.provider.isRunning(id),
            nativeConversation: vi.fn(async (request) => ({
              operationId: request.operationId,
              identity: request.source.identity,
              status: "unsupported" as const,
              reason: "native-history-control-unavailable",
            })),
          },
        },
        {
          conversationId: subConv.id,
          turnId: first.id,
          restoreFiles: true,
          source: {
            actorId: "human",
            commandId: "rollback-subdirectory-staged-test",
            command: { type: "conversation.rollback", conversationId: subConv.id, turnId: first.id, restoreFiles: true },
          },
        },
        new AbortController().signal,
      );

      expect(result.files.outcome).toBe("refused");
      expect(result.files.message).toContain("staged.txt");
      expect(readFileSync(join(appWorkspace, "staged.txt"), "utf8")).toBe("user edit after the turn\n");
    } finally {
      runtime.store.close();
    }
  }, 60_000);
});
