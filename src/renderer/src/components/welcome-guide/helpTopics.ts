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
  jump?: string;
  anchor?: string;
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
        jump: "Add a project",
      },
      {
        name: "Connect an agent",
        detail: "Inertia uses the accounts you already have with Codex, Claude, Cursor, Antigravity, Kimi Code and OpenCode. Each provider keeps its own sign-in. Connect or refresh one in Settings → Agents.",
        jump: "Open Settings → Agents",
      },
      {
        name: "Start a chat",
        detail: "Choose New chat in the sidebar, then describe the task in the composer.",
        shortcut: "new-chat",
      },
      {
        name: "Chats without a project",
        detail: "Choose No project from the composer's Project button, or Start without a project in the command palette. The chat works in its own chat folder, appears under No project in the sidebar and keeps that folder when it is deleted.",
      },
      {
        name: "Access modes",
        detail: "Supervised keeps provider approvals, Auto-accept edits allows supported file edits, and Full access lets the agent act without asking. Choose Full access only for a workspace and task you trust.",
      },
      {
        name: "Welcome guide",
        detail: "Replay the first-run tour at any time.",
        jump: "Show welcome guide",
      },
    ],
    jumps: [
      { label: "Add a project", command: "add-project" },
      { label: "Open Settings → Agents", settings: "agents" },
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
        detail: "Attach images, PDFs, text, Markdown, CSV, JSON and spreadsheets with the paperclip, or drop them on the composer: up to 100 files, 50 MiB each. Credential and key files (.env, .pem, .key) are refused.",
      },
      {
        name: "Large files and pasted text",
        detail: "Text pasted at 32 KiB becomes a file; Shift-paste keeps it inline. Images are resized to 10 MiB each (80 MiB combined), and agents receive file paths and read the contents as needed.",
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
        detail: "Add a custom backend in Settings → Agents to route a chat through your own compatible endpoint. Its credential is stored in the system credential vault.",
        jump: "Open Settings → Agents",
      },
      {
        name: "Provider sessions",
        detail: "A chat stays with the provider it started on; choosing another provider offers Start a new chat. If the provider can no longer open the saved session, the turn restarts once in a new one and shows a New provider session note.",
      },
    ],
    jumps: [
      { label: "Open Settings → Agents", settings: "agents" },
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
        detail: "The Plan and Goal surfaces show what the provider reports. Delegated agents appear in the transcript and in the Background tasks surface.",
      },
      {
        name: "Background tasks",
        detail: "Background tasks in the right panel lists the chat's delegated agents and the commands Inertia started, with what each is doing and the tokens it reports. A turn with agents shows one line, such as 2 agents working; choose it to open those tasks.",
      },
      {
        name: "Daily work",
        detail: "Daily work in the sidebar summarizes processed tokens, agent runtime and conversations for a day.",
        jump: "Open Daily work",
      },
      {
        name: "Notifications and mascot",
        detail: "Turn on desktop notifications or the desktop mascot in Settings → Notifications. Notifications leave out prompt and response text.",
        jump: "Open Settings → Notifications",
      },
      {
        name: "Sound when a task ends",
        detail: "Turn it on in Settings → Notifications to play a short sound when an agent finishes or stops with an error. Choose a built-in sound or import your own, and setting Play sound to After tasks longer than a chosen time keeps quick questions quiet.",
        jump: "Open Settings → Notifications",
      },
    ],
    jumps: [
      { label: "Open Daily work", command: "daily-work" },
      { label: "Open Settings → Notifications", settings: "notifications" },
    ],
  },
  {
    id: "tools",
    title: "Workspace tools",
    summary: "Open files, terminals and a browser next to the chat.",
    entries: [
      {
        name: "Surfaces",
        detail: "Open the right panel and choose Changes, Files, Browser, Terminal, Attachments, Background tasks, Usage, Goal or Plan. Each chat remembers its own surfaces.",
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
        name: "Attachment previews",
        detail: "The Attachments surface shows the files sent in this chat; choose one to preview it. Zoom an image with + and -, drag or use the arrow keys to pan, and press 0 to reset.",
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
        detail: "Revert on a turn restores the project to before that turn and saves current edits in a recovery checkpoint first. When saving a checkpoint fails, the turn's request row says so and gives the reason, shown on hover and read by screen readers.",
      },
    ],
    jumps: [
      { label: "Open Settings → Chats", settings: "chats" },
    ],
  },
  {
    id: "search",
    title: "Search and history",
    summary: "Find earlier work across projects and chats.",
    entries: [
      {
        name: "Search everything",
        detail: "Find commands, settings, projects, chats and saved messages. Type at least two characters to search your messages and final answers across unarchived chats.",
        shortcut: "search",
        jump: "Open search",
      },
      {
        name: "Earlier messages",
        detail: "Long chats open with recent history. Choose Load earlier messages at the top of the transcript, and Jump to latest to follow new content again.",
      },
      {
        name: "Archive",
        detail: "Archive thread hides a chat and keeps its data. Restore it from Settings → Data.",
        jump: "Open Settings → Data",
      },
    ],
    jumps: [
      { label: "Open search", command: "search" },
      { label: "Open Settings → Data", settings: "data" },
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
        jump: "Open Usage",
      },
      {
        name: "Limits",
        detail: "Each provider shows the remaining quota for every reported window with a countdown to its reset. A window shows Reset due until the provider reports new quota; Codex and Claude are checked again a few seconds after the reset. Refresh limits asks the providers right away.",
        jump: "Open Usage",
      },
      {
        name: "Resume at reset",
        detail: "When a chat stops at a subscription limit, the sidebar shows it as Limited and the composer offers Resume at reset and Snooze until reset. Inertia must be running to resume. If the provider has not reported new quota within an hour of the reset, or Inertia was closed at the time, nothing is sent and Resume now waits for you.",
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
        detail: "Turn on Window snapshots in Settings → Devices & integrations to attach a screenshot of the foreground window with its accessibility context. Choose its shortcut in Settings → Keyboard.",
        jump: "Open Settings → Devices & integrations",
      },
      {
        name: "Reviewed screenshots",
        detail: "On Linux, Take reviewed screenshot beside the attachment button captures a window or screen. Crop it and mask sensitive areas, then approve it before it is attached.",
      },
      {
        name: "Private Connect",
        detail: "Settings → Devices & integrations pairs a browser on another device over your Tailscale network while this computer stays online. Each paired device gets Monitor or Collaborate access.",
        jump: "Open Settings → Devices & integrations",
      },
      {
        name: "Discord",
        detail: "Settings → Devices & integrations prepares release notes and a commit preview to post to a Discord webhook.",
      },
    ],
    jumps: [
      { label: "Open Settings → Devices & integrations", settings: "devices" },
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    summary: "Make the workspace comfortable to read.",
    entries: [
      {
        name: "Themes",
        detail: "Choose System, Light or Dark and a colour theme from the theme library in Settings → Appearance.",
        jump: "Open Settings → Appearance",
      },
      {
        name: "Custom colours",
        detail: "Under Custom colours in Settings → Appearance, pick one colour for the light appearance and one for dark. Inertia adapts the shades to keep the workbench readable, and Reset returns that appearance to its previous preset.",
        jump: "Open Settings → Appearance",
      },
      {
        name: "Interface scale",
        detail: "Choose Compact, Default, Comfortable or Large.",
        jump: "Open Settings → Appearance",
      },
      {
        name: "Working indicator",
        detail: "Choose how running work is shown in the Work list and the working cue.",
        jump: "Open Settings → Appearance",
      },
    ],
    jumps: [
      { label: "Open Settings → Appearance", settings: "appearance" },
    ],
  },
  {
    id: "keys",
    title: "Keyboard",
    summary: "Common actions without the mouse. On macOS the modifier is ⌘; elsewhere it is Ctrl.",
    demo: "keys",
    entries: [
      {
        name: "Search everything",
        detail: "Open the command palette.",
        shortcut: "search",
        jump: "Open Settings → Keyboard",
      },
      {
        name: "New chat",
        detail: "Start a chat in the current project.",
        shortcut: "new-chat",
        jump: "Open Settings → Keyboard",
      },
      {
        name: "Project navigation",
        detail: "Show or hide the sidebar.",
        shortcut: "toggle-sidebar",
        jump: "Open Settings → Keyboard",
      },
      {
        name: "Terminal",
        detail: "Show or hide the terminal.",
        shortcut: "toggle-terminal",
        jump: "Open Settings → Keyboard",
      },
      { name: "Settings", detail: "⌘, on macOS or Ctrl+, elsewhere opens and closes Settings. Search settings finds a setting by name; ↑, ↓ and Enter open it. Escape clears the search, then leaves Settings." },
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
      { label: "Open Settings → Keyboard", settings: "keyboard" },
    ],
  },
  {
    id: "support",
    title: "Troubleshooting",
    summary: "Fix common problems and tell us about the rest.",
    entries: [
      {
        name: "An agent stops responding",
        detail: "Refresh it in Settings → Agents. Details under the provider show what is ready and what needs setup.",
      },
      {
        name: "Diagnostics",
        detail: "Settings → Help keeps a local history of app events and incidents that you can search, filter, export or clear. Capture can be turned off there.",
        jump: "Open Settings → Help",
        anchor: "diagnostics-incidents",
      },
      {
        name: "Report an issue",
        detail: "Report an issue in Settings → Help drafts a report. You review the exact text before anything is submitted to GitHub.",
        jump: "Open Settings → Help",
        anchor: "report-issue",
      },
      {
        name: "Support summary",
        detail: "Copy support summary, under Diagnostics in Settings → Help, copies a bounded summary to attach to a bug report.",
        jump: "Open Settings → Help",
        anchor: "runtime-diagnostics",
      },
      {
        name: "Updates",
        detail: "The update button in the sidebar footer and Settings → Help check for, download and install updates. Canary builds run as a separate app and can prepare a rollback.",
      },
    ],
    jumps: [
      { label: "Open Settings → Help", settings: "help" },
    ],
  },
];
