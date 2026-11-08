import { describe, expect, it, vi } from "vitest";

import type { ChangedFile, GitStatusSnapshot } from "../../src/shared/contracts";
import {
  paletteWorkspaceCommands,
  type PaletteWorkspaceInput,
} from "../../src/renderer/src/utils/paletteWorkspaceCommands";
import { conversation } from "./composer-fixtures";

const WORKSPACE_REASON = "Available after the first message creates this chat's workspace.";

function status(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    isRepository: true,
    root: "/workspace/inertia",
    branch: "feature/palette",
    upstream: "origin/feature/palette",
    ahead: 0,
    behind: 0,
    hasRemote: true,
    pullRequest: { available: true, remoteName: "origin", forge: "github", unavailableReason: null },
    files: [],
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

const modified: ChangedFile = {
  path: "src/app.ts",
  status: "modified",
  insertions: 1,
  deletions: 0,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: ".",
  worktreeStatus: "M",
};

function input(overrides: Partial<PaletteWorkspaceInput> = {}): PaletteWorkspaceInput {
  const chat = conversation("11111111-1111-4111-8111-111111111111");
  return {
    surfaces: { unavailable: {}, open: vi.fn() },
    git: {
      status: status(),
      busy: false,
      commit: vi.fn(),
      fetch: vi.fn(),
      pull: vi.fn(),
      push: vi.fn(),
      createPullRequest: vi.fn(),
      switchBranch: vi.fn(),
    },
    terminal: { unavailableReason: null, shortcut: "⌘J", toggle: vi.fn() },
    window: {
      conversation: chat,
      isDetached: false,
      detachedChatLimitReached: false,
      openInWindow: vi.fn(),
    },
    ...overrides,
  };
}

const ids = (value: PaletteWorkspaceInput): string[] => paletteWorkspaceCommands(value).map(({ id }) => id);
const command = (value: PaletteWorkspaceInput, id: string) => paletteWorkspaceCommands(value).find((entry) => entry.id === id);

describe("palette commands for the chat in the main window", () => {
  it("lists every surface by its panel label and opens it through the panel", () => {
    const value = input();
    const surfaces = paletteWorkspaceCommands(value).filter(({ group }) => group === "Surfaces");
    expect(surfaces.map(({ label }) => label)).toEqual([
      "Open Changes",
      "Open Files",
      "Open Browser",
      "Open Terminal",
      "Open Attachments",
      "Open Background tasks",
      "Open Usage",
      "Open Goal",
      "Open Plan",
    ]);
    surfaces.find(({ id }) => id === "surface:preview")!.run();
    expect(value.surfaces!.open).toHaveBeenCalledExactlyOnceWith("preview");
  });

  it("keeps workspace surfaces listed with their reason until the first message", () => {
    const value = input({
      surfaces: {
        unavailable: { changes: WORKSPACE_REASON, files: WORKSPACE_REASON, preview: WORKSPACE_REASON, terminal: WORKSPACE_REASON },
        open: vi.fn(),
      },
      terminal: { unavailableReason: WORKSPACE_REASON, toggle: vi.fn() },
    });
    const commands = paletteWorkspaceCommands(value);
    for (const id of ["surface:changes", "surface:files", "surface:preview", "surface:terminal", "window:toggle-terminal"]) {
      expect(commands.find((entry) => entry.id === id)?.disabledReason).toBe(WORKSPACE_REASON);
    }
    expect(commands.find((entry) => entry.id === "surface:plan")?.disabledReason).toBeUndefined();
    expect(ids(input({ surfaces: null }))).not.toContain("surface:changes");
  });

  it("offers only the Git actions the header would enable", () => {
    expect(ids(input()).filter((id) => id.startsWith("git:"))).toEqual(["git:fetch", "git:pull-request", "git:branch"]);
    const local = status({ hasRemote: false, upstream: null, pullRequest: { available: false, remoteName: null, forge: null, unavailableReason: "no-remotes" } });
    expect(ids(input({ git: { ...input().git!, status: { ...local, files: [modified] } } })).filter((id) => id.startsWith("git:")))
      .toEqual(["git:commit", "git:branch"]);
    expect(ids(input({ git: { ...input().git!, status: status({ ahead: 2 }) } }))).toContain("git:push");
    expect(ids(input({ git: { ...input().git!, status: status({ behind: 3 }) } }))).toContain("git:pull");

    const diverged = ids(input({ git: { ...input().git!, status: status({ ahead: 1, behind: 1 }) } }));
    expect(diverged).not.toContain("git:pull");
    expect(diverged).not.toContain("git:push");
    expect(diverged).not.toContain("git:pull-request");

    expect(ids(input({ git: { ...input().git!, busy: true, status: status({ files: [modified] }) } }))
      .filter((id) => id.startsWith("git:"))).toEqual([]);
    expect(ids(input({ git: { ...input().git!, status: status({ isRepository: false }) } }))
      .some((id) => id.startsWith("git:"))).toBe(false);
    expect(ids(input({ git: { ...input().git!, status: null } })).some((id) => id.startsWith("git:"))).toBe(false);
  });

  it("names Git actions for the palette and runs the matching header flow", () => {
    const value = input({ git: { ...input().git!, status: status({ files: [modified] }) } });
    const commit = command(value, "git:commit")!;
    expect(commit).toMatchObject({ group: "Git", label: "Commit…", detail: "Review and commit 1 changed file." });
    commit.run();
    expect(value.git!.commit).toHaveBeenCalledOnce();

    const publishable = input({ git: { ...input().git!, status: status({ upstream: null }) } });
    expect(command(publishable, "git:push")?.label).toBe("Push");
    const reviewable = input({ git: { ...input().git!, status: status({ pullRequest: { available: true, remoteName: "origin", forge: "github", unavailableReason: null } }) } });
    const pullRequest = command(reviewable, "git:pull-request")!;
    expect(pullRequest.label).toBe("Create pull request…");
    pullRequest.run();
    expect(reviewable.git!.createPullRequest).toHaveBeenCalledOnce();

    const branch = command(value, "git:branch")!;
    expect(branch.label).toBe("Switch branch…");
    branch.run();
    expect(value.git!.switchBranch).toHaveBeenCalledOnce();
    expect(command(input({ git: { ...input().git!, status: status({ branch: null }) } }), "git:branch")?.label)
      .toBe("Create branch…");
  });

  it("applies the window rules from the chat actions menu and leaves split view out", () => {
    const value = input();
    const chat = value.window!.conversation;
    expect(command(value, "window:toggle-terminal")).toMatchObject({ label: "Toggle terminal dock", shortcut: "⌘J" });
    command(value, "window:toggle-terminal")!.run();
    expect(value.terminal!.toggle).toHaveBeenCalledOnce();

    expect(ids(value).filter((id) => id.startsWith("window:"))).toEqual(["window:toggle-terminal", "window:new-window"]);
    expect(paletteWorkspaceCommands(value).some(({ label }) => /split view/iu.test(label))).toBe(false);

    const newWindow = command(value, "window:new-window")!;
    expect(newWindow).toMatchObject({ label: "Open chat in a new window" });
    expect(newWindow.disabledReason).toBeUndefined();
    newWindow.run();
    expect(value.window!.openInWindow).toHaveBeenCalledExactlyOnceWith(chat);
    expect(command(input({ window: { ...value.window!, detachedChatLimitReached: true } }), "window:new-window")?.disabledReason)
      .toBe("Close a chat window before opening another.");
    expect(command(input({ window: { ...value.window!, isDetached: true, detachedChatLimitReached: true } }), "window:new-window"))
      .toMatchObject({ label: "Focus chat window" });
    expect(command(input({ window: { ...value.window!, isDetached: true, detachedChatLimitReached: true } }), "window:new-window"))
      .not.toHaveProperty("disabledReason");
    expect(ids(input({ window: null })).filter((id) => id.startsWith("window:"))).toEqual(["window:toggle-terminal"]);
  });

  it("gives every command a stable, unique id", () => {
    const all = ids(input({ git: { ...input().git!, status: status({ files: [modified], upstream: null }) } }));
    expect(new Set(all).size).toBe(all.length);
  });
});
