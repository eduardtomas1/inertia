import type { Conversation, GitStatusSnapshot } from "@shared/contracts";

import type { WorkspacePanelTab } from "../components/workspacePanelTypes";
import { headerGitActions, type HeaderGitActionId } from "./headerGitActions";
import { RIGHT_PANEL_SURFACE_META, RIGHT_PANEL_SURFACES } from "./rightPanelSurfaces";

export type PaletteWorkspaceGroup = "Surfaces" | "Git" | "Window";

export type PaletteWorkspaceIcon =
  | { kind: "surface"; surface: WorkspacePanelTab }
  | { kind: "git"; action: HeaderGitActionId | "branch" }
  | { kind: "window"; action: "terminal-dock" | "new-window" };

/** A command for the chat shown in the main window. */
export interface PaletteWorkspaceCommand {
  id: string;
  group: PaletteWorkspaceGroup;
  label: string;
  detail?: string;
  keywords?: string;
  icon: PaletteWorkspaceIcon;
  shortcut?: string;
  /** Present when the command is listed but cannot run yet. */
  disabledReason?: string;
  run: () => void;
}

export interface PaletteWorkspaceInput {
  /** The main chat's right panel; null when the chat has no tool panel. */
  surfaces: {
    unavailable: Partial<Record<WorkspacePanelTab, string>>;
    open: (surface: WorkspacePanelTab) => void;
  } | null;
  /** The header Git controls for the chat's repository. */
  git: {
    status: GitStatusSnapshot | null;
    busy: boolean;
    commit: () => void;
    fetch: () => void;
    pull: () => void;
    push: () => void;
    createPullRequest: () => void;
    switchBranch: () => void;
  } | null;
  terminal: {
    unavailableReason: string | null;
    shortcut?: string;
    toggle: () => void;
  } | null;
  /** Only a saved chat can move into its own window. */
  window: {
    conversation: Conversation;
    isDetached: boolean;
    detachedChatLimitReached: boolean;
    openInWindow: (conversation: Conversation) => void;
  } | null;
}

const SURFACE_KEYWORDS: Record<WorkspacePanelTab, string> = {
  changes: "diff review hunks stage git",
  files: "file tree explorer browse",
  preview: "preview web page localhost url",
  terminal: "shell console command line",
  attachments: "images uploads pasted",
  agents: "subagents delegated agents running",
  usage: "limits quota tokens context",
  goal: "objective target",
  plan: "steps todo checklist",
};

const GIT_LABELS: Record<HeaderGitActionId, { label: string; keywords: string }> = {
  commit: { label: "Commit…", keywords: "git save changes" },
  fetch: { label: "Fetch", keywords: "git remote refresh incoming" },
  pull: { label: "Pull", keywords: "git sync incoming upstream" },
  push: { label: "Push", keywords: "git publish upload outgoing upstream" },
  "pull-request": { label: "Create pull request…", keywords: "git pr review forge github" },
};

const GIT_ORDER: readonly HeaderGitActionId[] = ["commit", "fetch", "pull", "push", "pull-request"];

function surfaceCommands(input: NonNullable<PaletteWorkspaceInput["surfaces"]>): PaletteWorkspaceCommand[] {
  return RIGHT_PANEL_SURFACES.map((surface) => {
    const reason = input.unavailable[surface];
    return {
      id: `surface:${surface}`,
      group: "Surfaces",
      label: `Open ${RIGHT_PANEL_SURFACE_META[surface].label}`,
      keywords: `surface panel ${SURFACE_KEYWORDS[surface]}`,
      icon: { kind: "surface", surface },
      ...(reason ? { disabledReason: reason } : {}),
      run: () => input.open(surface),
    };
  });
}

function gitCommands(input: NonNullable<PaletteWorkspaceInput["git"]>): PaletteWorkspaceCommand[] {
  const { status } = input;
  if (!status?.isRepository) return [];
  const runners: Record<HeaderGitActionId, () => void> = {
    commit: input.commit,
    fetch: input.fetch,
    pull: input.pull,
    push: input.push,
    "pull-request": input.createPullRequest,
  };
  const actions = headerGitActions(status, input.busy);
  const commands: PaletteWorkspaceCommand[] = GIT_ORDER.flatMap((id) => {
    const action = actions.find((candidate) => candidate.id === id);
    if (!action || action.disabled) return [];
    return [{
      id: `git:${id}`,
      group: "Git" as const,
      label: GIT_LABELS[id].label,
      detail: action.detail,
      keywords: GIT_LABELS[id].keywords,
      icon: { kind: "git" as const, action: id },
      run: runners[id],
    }];
  });
  if (!input.busy) {
    commands.push({
      id: "git:branch",
      group: "Git",
      label: status.branch ? "Switch branch…" : "Create branch…",
      detail: status.branch
        ? `Currently on ${status.branch}.`
        : "Detached HEAD: create and check out a branch.",
      keywords: "git checkout branches create worktree",
      icon: { kind: "git", action: "branch" },
      run: input.switchBranch,
    });
  }
  return commands;
}

function windowCommands(input: PaletteWorkspaceInput): PaletteWorkspaceCommand[] {
  const commands: PaletteWorkspaceCommand[] = [];
  if (input.terminal) {
    const { terminal } = input;
    commands.push({
      id: "window:toggle-terminal",
      group: "Window",
      label: "Toggle terminal dock",
      keywords: "terminal shell dock bottom",
      icon: { kind: "window", action: "terminal-dock" },
      ...(terminal.shortcut ? { shortcut: terminal.shortcut } : {}),
      ...(terminal.unavailableReason ? { disabledReason: terminal.unavailableReason } : {}),
      run: terminal.toggle,
    });
  }
  const target = input.window;
  if (!target) return commands;
  const windowLimited = !target.isDetached && target.detachedChatLimitReached;
  commands.push({
    id: "window:new-window",
    group: "Window",
    label: target.isDetached ? "Focus chat window" : "Open chat in a new window",
    keywords: "detach window separate pop out",
    icon: { kind: "window", action: "new-window" },
    ...(windowLimited ? { disabledReason: "Close a chat window before opening another." } : {}),
    run: () => target.openInWindow(target.conversation),
  });
  return commands;
}

/**
 * Builds the palette's commands for the chat in the main window. Surfaces and
 * window actions that cannot run yet stay listed with their reason; Git
 * actions appear only while the header would enable them.
 */
export function paletteWorkspaceCommands(input: PaletteWorkspaceInput): PaletteWorkspaceCommand[] {
  return [
    ...(input.surfaces ? surfaceCommands(input.surfaces) : []),
    ...(input.git ? gitCommands(input.git) : []),
    ...windowCommands(input),
  ];
}
