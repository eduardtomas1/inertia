import type { AppShortcutAction } from "@shared/keybindings";

import type { SettingsSection } from "../../lib/settingsTarget";
import type { WelcomeTopicId } from "./welcomeGuideModel";

export const HELP_COMMANDS = [
  "add-project",
  "search",
  "usage",
  "daily-work",
  "welcome-guide",
] as const;

export type HelpCommand = typeof HELP_COMMANDS[number];

export type HelpJump =
  | { label: string; command: HelpCommand }
  | { label: string; settings: SettingsSection };

export interface HelpEntry {
  name: string;
  detail: string;
  shortcut?: AppShortcutAction;
}

export interface HelpTopic {
  id: string;
  title: string;
  summary: string;
  demo?: WelcomeTopicId;
  entries: readonly HelpEntry[];
  jumps: readonly HelpJump[];
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: "start",
    title: "Getting started",
    summary: "Add a project, connect an agent and start a chat.",
    entries: [
      {
        name: "Add a project",
        detail: "Open a local folder or clone a repository from an HTTPS or SSH Git URL. Use Add project in the sidebar or the command palette.",
      },
      {
        name: "Connect an agent",
        detail: "Inertia uses the accounts you already have with Codex, Claude, Cursor, Antigravity, Kimi Code and OpenCode. Each provider keeps its own sign-in. Connect or refresh one in Settings → Providers.",
      },
      {
        name: "Start a chat",
        detail: "Choose New chat in the sidebar, then describe the task in the composer.",
        shortcut: "new-chat",
      },
      {
        name: "Access modes",
        detail: "Supervised keeps provider approvals, Auto-accept edits allows supported file edits, and Full access lets the agent act without asking. Choose Full access only for a workspace and task you trust.",
      },
      {
        name: "Welcome guide",
        detail: "Replay the first-run tour at any time.",
      },
    ],
    jumps: [
      { label: "Add a project", command: "add-project" },
      { label: "Open Settings → Providers", settings: "providers" },
      { label: "Show welcome guide", command: "welcome-guide" },
    ],
  },
  {
    id: "chat",
    title: "Chat and composer",
    summary: "Give the agent context, choose how it works and keep follow-ups moving.",
    entries: [
      {
        name: "Attachments",
        detail: "Attach images, PDFs, text, Markdown, CSV, JSON and spreadsheets with the paperclip, or drop them on the composer. Up to 100 files, 50 MiB each. Images are resized to 10 MiB each (80 MiB combined). Text pasted at 32 KiB becomes a file; Shift-paste keeps it inline. Agents receive file paths and read the contents as needed.",
      },
      {
        name: "Mentions and skills",
        detail: "Type @ to reference a project file or another chat, including this chat's earlier messages. Type $ and part of a name to insert a provider skill.",
      },
      {
        name: "Chat commands",
        detail: "Type / for commands: /plan and /build switch the work mode, /goal views or sets the chat's goal, /compact compacts the provider context and /resume resumes a provider chat from this folder.",
      },
      {
        name: "Follow-ups",
        detail: "While an agent works, Enter sends a follow-up and Tab queues it for the next turn. Send now sends a queued message right away.",
      },
      {
        name: "Model, reasoning and mode",
        detail: "Choose the model, reasoning level, response speed, work mode and access from the composer. In Plan mode the agent inspects and proposes steps first.",
      },
      {
        name: "Prompt presets",
        detail: "Save reusable prompts in Prompt presets and keep drafts for this chat in Scratch prompts. Presets never send automatically.",
      },
      {
        name: "Custom backends",
        detail: "Add a backend profile in Settings → Model backends to route a chat through your own compatible endpoint. Its credential is stored in the system credential vault.",
      },
    ],
    jumps: [
      { label: "Open Settings → Model backends", settings: "backends" },
    ],
  },
  {
    id: "work",
    title: "Following work",
    summary: "Keep track of every running chat without watching each one.",
    demo: "work",
    entries: [
      {
        name: "Work list",
        detail: "The sidebar lists your chats with live activity and elapsed time. A chat that needs your input or finishes gets a brief cue.",
      },
      {
        name: "Organize chats",
        detail: "Right-click a chat, or focus it and press Shift+F10, to pin, snooze, settle, rename, archive or open it in another window.",
      },
      {
        name: "Plan, goal and subagents",
        detail: "The Plan and Goal surfaces show what the provider reports. Delegated agents appear in the transcript and in the Agents surface.",
      },
      {
        name: "Daily work",
        detail: "Daily work in the sidebar summarizes processed tokens, agent runtime and conversations for a day.",
      },
      {
        name: "Notifications and mascot",
        detail: "Turn on desktop notifications or the desktop mascot in Settings → General. Notifications leave out prompt and response text.",
      },
    ],
    jumps: [
      { label: "Open Daily work", command: "daily-work" },
      { label: "Open Settings → General", settings: "general" },
    ],
  },
  {
    id: "tools",
    title: "Workspace tools",
    summary: "Open files, terminals and a browser next to the chat.",
    entries: [
      {
        name: "Surfaces",
        detail: "Open the right panel and choose Changes, Files, Browser, Terminal, Attachments, Agents, Usage, Goal or Plan. Each chat remembers its own surfaces.",
      },
      {
        name: "Terminal",
        detail: "Run commands in the project with tabs and splits, in the panel or docked under the chat.",
        shortcut: "toggle-terminal",
      },
      {
        name: "Files",
        detail: "Browse project files, preview Markdown and edit a file in place.",
      },
      {
        name: "Browser",
        detail: "Open local development pages for the selected chat. Supported agents can use the same pages, and Evidence keeps a local record of what happened.",
      },
      {
        name: "Project navigation",
        detail: "Show or hide the sidebar.",
        shortcut: "toggle-sidebar",
      },
    ],
    jumps: [],
  },
  {
    id: "multi",
    title: "Side by side",
    summary: "Work on several chats at once.",
    demo: "split",
    entries: [
      {
        name: "Split view",
        detail: "Drag a chat from the sidebar onto the workspace, or choose Add this chat to split view in its actions. Up to four chats show at once, each with its own project, tools and draft.",
      },
      {
        name: "Chat windows",
        detail: "Choose Open chat in new window in a chat's actions. Up to eight chats can have their own windows.",
      },
      {
        name: "Duo",
        detail: "Launch two chats in the sidebar sends one brief to two agents. Turn on Compare with a third model to add an independent judge.",
      },
    ],
    jumps: [],
  },
  {
    id: "git",
    title: "Review and ship",
    summary: "Check an agent's work before it leaves your computer.",
    demo: "ship",
    entries: [
      {
        name: "Changes",
        detail: "Review changed files, mark hunks and files as reviewed, and select lines to ask about them, request a revision or revert them. N and P move between hunks.",
      },
      {
        name: "Commit and push",
        detail: "Commit from the Git button in the header, choosing exactly which paths to include, then push. Pull only fast-forwards, and Inertia never force-pushes.",
      },
      {
        name: "Branches and worktrees",
        detail: "The branch menu searches, creates and switches branches, and starts chats on a branch or in an isolated worktree.",
      },
      {
        name: "Pull requests",
        detail: "Open a pull request from the Git menu; on GitHub it uses your local GitHub CLI sign-in. Confidence in the Changes surface checks it before you merge.",
      },
      {
        name: "Checkpoints",
        detail: "Revert on a turn restores the project to before that turn and saves current edits in a recovery checkpoint first.",
      },
    ],
    jumps: [
      { label: "Open Settings → Source control", settings: "source" },
    ],
  },
  {
    id: "search",
    title: "Search and history",
    summary: "Find earlier work across projects and chats.",
    entries: [
      {
        name: "Search everything",
        detail: "Find commands, projects, chats and saved messages. Type at least two characters to search your messages and final answers across unarchived chats.",
        shortcut: "search",
      },
      {
        name: "Earlier messages",
        detail: "Long chats open with recent history. Choose Load earlier messages at the top of the transcript, and Jump to latest to follow new content again.",
      },
      {
        name: "Archive",
        detail: "Archive thread hides a chat and keeps its data. Restore it from Settings → Archive & data.",
      },
    ],
    jumps: [
      { label: "Open search", command: "search" },
      { label: "Open Settings → Archive & data", settings: "archive" },
    ],
  },
  {
    id: "usage",
    title: "Usage and limits",
    summary: "See what you used and how much quota is left.",
    demo: "limits",
    entries: [
      {
        name: "History",
        detail: "Usage in the sidebar shows locally recorded usage across chats and providers.",
      },
      {
        name: "Limits",
        detail: "Each provider shows the remaining quota for every reported window with a countdown to its reset. Refresh limits asks the providers again; a countdown reaching zero does not refill a bar.",
      },
      {
        name: "In the composer",
        detail: "The usage indicator shows the context window and the selected account's quota.",
      },
    ],
    jumps: [
      { label: "Open Usage", command: "usage" },
    ],
  },
  {
    id: "connect",
    title: "Snapshots and devices",
    summary: "Capture other windows and reach Inertia from another device.",
    entries: [
      {
        name: "Snapshots",
        detail: "Turn on Snapshots in Settings → Snapshots to attach a screenshot of the foreground window with its accessibility context, using the capture shortcut you choose there.",
      },
      {
        name: "Private Connect",
        detail: "Settings → Connections & devices pairs a browser on another device over your Tailscale network while this computer stays online. Each paired device gets Monitor or Collaborate access.",
      },
      {
        name: "Discord",
        detail: "Settings → Discord prepares release notes and a commit preview to post to a Discord webhook.",
      },
    ],
    jumps: [
      { label: "Open Settings → Snapshots", settings: "snapshots" },
      { label: "Open Settings → Connections & devices", settings: "connections" },
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    summary: "Make the workspace comfortable to read.",
    entries: [
      {
        name: "Themes",
        detail: "Choose System, Light or Dark and a color theme from the theme library in Settings → General.",
      },
      {
        name: "Interface scale",
        detail: "Choose Compact, Default, Comfortable or Large.",
      },
      {
        name: "Working indicator",
        detail: "Choose how running work is shown in the Work list and the working cue.",
      },
    ],
    jumps: [
      { label: "Open Settings → General", settings: "general" },
    ],
  },
  {
    id: "keys",
    title: "Keyboard",
    summary: "Common actions without the mouse. On macOS the modifier is ⌘; elsewhere it is Ctrl.",
    demo: "keys",
    entries: [
      { name: "Search everything", detail: "Open the command palette.", shortcut: "search" },
      { name: "New chat", detail: "Start a chat in the current project.", shortcut: "new-chat" },
      { name: "Project navigation", detail: "Show or hide the sidebar.", shortcut: "toggle-sidebar" },
      { name: "Terminal", detail: "Show or hide the terminal.", shortcut: "toggle-terminal" },
      {
        name: "Chats and transcript",
        detail: "Shift+F10 opens a focused chat's actions. In the transcript, Alt+↑ and Alt+↓ move between turns.",
      },
      {
        name: "Composer",
        detail: "Enter sends and Shift+Enter adds a line. ↑ and ↓ at the start or end of the draft recall earlier prompts.",
      },
    ],
    jumps: [
      { label: "Open Settings → Keybindings", settings: "keybindings" },
    ],
  },
  {
    id: "support",
    title: "Troubleshooting",
    summary: "Fix common problems and tell us about the rest.",
    entries: [
      {
        name: "An agent stops responding",
        detail: "Refresh it in Settings → Providers. Feature availability there shows what is ready and what needs setup.",
      },
      {
        name: "Diagnostics",
        detail: "Settings → Diagnostics keeps a local history of incidents that you can search, filter and export.",
      },
      {
        name: "Report an issue",
        detail: "Settings → Report an issue drafts a report. You review the exact text before anything is submitted to GitHub. Storage & backups on the same page shows local storage and backups.",
      },
      {
        name: "Support summary",
        detail: "Copy support summary, under Runtime diagnostics in Settings → Archive & data, copies a bounded summary to attach to a bug report.",
      },
      {
        name: "Updates",
        detail: "The update button in the sidebar footer and Settings → General check for, download and install updates. Canary builds run as a separate app and can prepare a rollback.",
      },
    ],
    jumps: [
      { label: "Open Settings → Diagnostics", settings: "diagnostics" },
      { label: "Open Settings → Report an issue", settings: "support" },
    ],
  },
];
