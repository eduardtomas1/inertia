import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientCommand } from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function linkedWorkspace(): {
  data: string;
  gitDirectory: string;
  replacement: string;
  replacementCommonDirectory: string;
  source: string;
  workspace: string;
} {
  const root = mkdtempSync(join(tmpdir(), "inertia-conversation-worktree-"));
  temporaryDirectories.push(root);
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  const replacement = join(root, "replacement");
  const data = join(root, "data");
  mkdirSync(source);
  mkdirSync(replacement);
  git(source, "init", "-q", "--initial-branch=main");
  git(source, "config", "user.name", "Inertia Tests");
  git(source, "config", "user.email", "tests@inertia.invalid");
  git(source, "commit", "--allow-empty", "-m", "Initial");
  git(source, "worktree", "add", "-q", "-b", "linked", workspace);
  git(replacement, "init", "-q", "--initial-branch=main");
  git(replacement, "config", "user.name", "Inertia Tests");
  git(replacement, "config", "user.email", "tests@inertia.invalid");
  git(replacement, "commit", "--allow-empty", "-m", "Replacement");
  return {
    data,
    gitDirectory: git(
      workspace,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ),
    replacement,
    replacementCommonDirectory: git(
      replacement,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ),
    source,
    workspace,
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("conversation isolated-worktree source identity", () => {
  it("rejects a queued linked-root common-directory replacement before mutation", async () => {
    const fixture = linkedWorkspace();
    const deleteConversation = vi.fn();
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
    const createConversation = vi.fn(() => ({ id: conversationId }));
    const dependencies = {
      store: {
        shellSnapshot: vi.fn(() => ({
          settings: {
            defaultProvider: "codex",
            defaultModel: "gpt-test",
            defaultReasoningEffort: "high",
          },
        })),
        projectPath: vi.fn(() => fixture.workspace),
        createConversation,
        deleteConversation,
      },
      providers: {
        resolveModelRoute: vi.fn(() => ({ providerId: "codex" })),
      },
      backendProfileController: {
        validateSelection: vi.fn((selection: unknown) => selection),
      },
      workspaceRuns: { trackSourceControl },
      dataDirectory: fixture.data,
      broadcastSnapshot: vi.fn(),
      send: vi.fn(),
    } as unknown as ConversationCommandDependencies;
    const command: Extract<ClientCommand, { type: "conversation.create" }> = {
      type: "conversation.create",
      requestId: "33333333-3333-4333-8333-333333333333",
      payload: {
        projectId,
        title: "Redirect-safe isolated chat",
        modelSelection: modelSelectionSchema.parse(nativeModelSelection({
          providerId: "codex",
          modelId: "gpt-test",
          alias: "GPT Test",
          reasoningEffort: "high",
        })),
        interactionMode: "build",
        accessMode: "supervised",
        useWorktree: true,
      },
    };

    await expect(createConversationCommandHandler(dependencies)(
      {} as never,
      command,
    )).rejects.toThrow(/repository changed while its isolated worktree/iu);

    expect(trackSourceControl).toHaveBeenCalledOnce();
    expect(createConversation).toHaveBeenCalledOnce();
    expect(deleteConversation).toHaveBeenCalledWith(conversationId);
    expect(existsSync(join(fixture.data, "worktrees", conversationId)))
      .toBe(false);
    expect(git(fixture.source, "branch", "--list", "inertia/*")).toBe("");
    expect(git(fixture.replacement, "branch", "--list", "inertia/*"))
      .toBe("");
    expect(dependencies.send).not.toHaveBeenCalled();
  });

  it("retains a durable conversation receipt when source metadata changes after creation", async () => {
    const fixture = linkedWorkspace();
    const deleteConversation = vi.fn();
    const updateConversation = vi.fn((
      _id: string,
      _update: { branch?: string | null; worktreePath?: string | null },
    ) => ({ id: conversationId }));
    const broadcastSnapshot = vi.fn();
    const dependencies = {
      store: {
        shellSnapshot: vi.fn(() => ({
          settings: {
            defaultProvider: "codex",
            defaultModel: "gpt-test",
            defaultReasoningEffort: "high",
          },
        })),
        projectPath: vi.fn(() => fixture.workspace),
        createConversation: vi.fn(() => ({ id: conversationId })),
        updateConversation,
        deleteConversation,
      },
      providers: {
        resolveModelRoute: vi.fn(() => ({ providerId: "codex" })),
      },
      backendProfileController: {
        validateSelection: vi.fn((selection: unknown) => selection),
      },
      workspaceRuns: {
        trackSourceControl: vi.fn(async (
          _label: string,
          _projectId: string,
          _conversationId: string | undefined,
          _cwd: string,
          _requestId: string,
          operation: () => Promise<unknown>,
        ) => await operation()),
      },
      dataDirectory: fixture.data,
      broadcastSnapshot,
      send: vi.fn(),
      testHooks: {
        afterIsolatedWorktreeCreate: () => {
          writeFileSync(
            join(fixture.gitDirectory, "commondir"),
            `${fixture.replacementCommonDirectory}\n`,
          );
        },
      },
    } as unknown as ConversationCommandDependencies;
    const command: Extract<ClientCommand, { type: "conversation.create" }> = {
      type: "conversation.create",
      requestId: "44444444-4444-4444-8444-444444444444",
      payload: {
        projectId,
        title: "Recoverable isolated chat",
        modelSelection: modelSelectionSchema.parse(nativeModelSelection({
          providerId: "codex",
          modelId: "gpt-test",
          alias: "GPT Test",
          reasoningEffort: "high",
        })),
        interactionMode: "build",
        accessMode: "supervised",
        useWorktree: true,
      },
    };

    await expect(createConversationCommandHandler(dependencies)(
      {} as never,
      command,
    )).rejects.toThrow(/repository changed while its isolated worktree/iu);

    const target = join(fixture.data, "worktrees", conversationId);
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(updateConversation).toHaveBeenLastCalledWith(conversationId, {
      worktreePath: expect.any(String),
      branch: `inertia/${conversationId.slice(0, 8)}`,
    });
    const retainedPath = updateConversation.mock.lastCall?.[1]?.worktreePath;
    expect(typeof retainedPath).toBe("string");
    expect(realpathSync(retainedPath as string)).toBe(realpathSync(target));
    expect(existsSync(target)).toBe(true);
    expect(git(
      fixture.source,
      "rev-parse",
      "--verify",
      `inertia/${conversationId.slice(0, 8)}`,
    )).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(git(fixture.replacement, "branch", "--list", "inertia/*"))
      .toBe("");
    expect(broadcastSnapshot).toHaveBeenCalledOnce();
    expect(dependencies.send).not.toHaveBeenCalled();
  });
});
