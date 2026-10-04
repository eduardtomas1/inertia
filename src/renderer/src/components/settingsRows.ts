import type { SettingsSection } from "../lib/settingsTarget";

export interface SettingsRowMetadata {
  id: string;
  sectionId: SettingsSection;
  title: string;
  keywords: readonly string[];
  group: string;
}

export interface SettingsSectionRows {
  id: SettingsSection;
  label: string;
  rows: readonly SettingsRowMetadata[];
}

type RowEntry = readonly [id: string, title: string, keywords: readonly string[]];

function section(id: SettingsSection, label: string, groups: Record<string, readonly RowEntry[]>): SettingsSectionRows {
  return {
    id,
    label,
    rows: Object.entries(groups).flatMap(([group, entries]) =>
      entries.map(([rowId, title, keywords]) => ({ id: rowId, sectionId: id, title, keywords, group }))),
  };
}

export const SETTINGS_SECTION_ROWS: readonly SettingsSectionRows[] = [
  section("appearance", "Appearance", {
    Theme: [
      ["appearance-mode", "Theme", ["appearance", "dark mode", "light mode", "system", "colour", "color", "custom colours", "palette", "general"]],
    ],
    "Scale and density": [
      ["interface-scale", "Interface scale", ["zoom", "font", "font size", "text size", "bigger", "smaller", "general"]],
      ["response-density", "Text density", ["spacing", "font", "type size", "response density", "compact", "general"]],
    ],
    "Working indicator": [
      ["working-indicator", "Working indicator", ["agent activity", "animation", "orb", "speed", "colour", "spinner", "general"]],
      ["working-indicator-glow", "Glow", ["halo", "working indicator", "animation"]],
      ["working-indicator-activity", "Animate tool and step activity", ["automatic", "subagents", "working indicator", "advanced"]],
    ],
  }),
  section("chats", "Chats", {
    "New chats": [
      ["new-chat-defaults", "New chat defaults", ["default provider", "default model", "defaults", "general"]],
      ["new-chat-model", "Model", ["default model", "default provider", "backend", "provider", "new chat defaults"]],
      ["new-chat-reasoning", "Reasoning", ["default reasoning", "effort", "thinking"]],
      ["new-chat-work-mode", "Work mode", ["build", "plan", "mode"]],
      ["new-chat-access", "Access", ["supervised", "auto-accept edits", "full access", "permissions", "approvals"]],
      ["new-chat-location", "Where new chats run", ["worktree", "checkout", "branch", "chat location", "workspace default"]],
    ],
    Transcript: [
      ["thinking-summaries", "Show reasoning summaries", ["thinking", "reasoning", "live thinking summaries", "general"]],
      ["collapse-work-log", "Collapse completed work logs", ["tool activity", "work log", "general"]],
      ["jump-to-answers", "Scroll to the start of new answers", ["scroll", "jump to completed answers", "final answer", "general"]],
      ["message-timestamps", "Message timestamps", ["time", "date", "general"]],
      ["changed-file-summaries", "Show changed files after each turn", ["files", "summary", "changed-file summaries", "general"]],
      ["code-wrap", "Wrap code by default", ["code blocks", "line wrap", "general"]],
      ["auto-open-plan", "Open plan automatically", ["plan panel", "general"]],
      ["confirm-destructive-actions", "Confirm destructive actions", ["delete", "warning", "confirmation", "general"]],
      ["usage-display", "Usage display", ["quota", "token", "tokens", "limit", "limits", "context", "usage and context", "general"]],
    ],
    "Review and terminal": [
      ["wrap-diffs", "Wrap long diff lines", ["diff", "wrap", "review", "source control"]],
      ["ignore-whitespace", "Ignore whitespace", ["diff", "whitespace", "review", "source control"]],
      ["terminal-font-size", "Terminal font size", ["font", "text size", "zoom", "terminal"]],
    ],
  }),
  section("notifications", "Notifications", {
    Alerts: [
      ["desktop-notifications", "Desktop notifications", ["alerts", "notify", "mute", "general"]],
      ["notify-only-in-background", "Only when Inertia is in the background", ["focus", "foreground", "quiet", "mute", "notifications"]],
    ],
    Sound: [
      ["completion-sound", "Completion sound", ["sounds", "chime", "audio", "custom sounds", "your sounds", "import sound", "general"]],
      ["completion-sound-enabled", "Sound when a task ends", ["sounds", "audio", "mute", "chime"]],
      ["completion-sound-long-runs", "Only after long tasks", ["sounds", "long tasks", "threshold", "quiet"]],
    ],
    "Quota warnings": [
      ["quota-warnings", "Quota warnings", ["limit", "limits", "usage", "quota", "rate limit"]],
      ["quota-warning-threshold", "Warn when below", ["threshold", "percent", "remaining", "quota", "limit"]],
    ],
    "Desktop mascot": [
      ["desktop-mascot", "Desktop mascot", ["mascot", "companion", "sprites", "custom sprites", "general"]],
      ["mascot-motion", "Animate mascot", ["mascot", "animation", "motion", "pause"]],
    ],
  }),
  section("keyboard", "Keyboard", {
    "App shortcuts": [
      ["shortcut-search", "Search everything", ["command palette", "keyboard shortcuts", "shortcut", "hotkey", "keybindings"]],
      ["shortcut-new-chat", "New chat", ["keyboard shortcuts", "shortcut", "hotkey", "keybindings"]],
      ["shortcut-toggle-sidebar", "Toggle project navigation", ["sidebar", "keyboard shortcuts", "shortcut", "hotkey", "keybindings"]],
      ["shortcut-toggle-terminal", "Toggle terminal", ["terminal", "keyboard shortcuts", "shortcut", "hotkey", "keybindings"]],
      ["open-settings", "Open settings", ["preferences", "comma", "shortcut", "hotkey", "keybindings"]],
      ["reset-shortcuts", "Reset shortcuts", ["keyboard defaults", "keyboard shortcuts", "hotkey", "keybindings"]],
    ],
    "Global shortcut": [
      ["snapshot-shortcut", "Window snapshot", ["capture", "screenshot", "snapshot", "shortcut", "hotkey", "keybindings"]],
    ],
  }),
  section("projects", "Projects", {
    "All projects": [
      ["project-chooser", "Project", ["choose project", "select project", "all projects"]],
      ["project-grouping", "Group projects", ["repository", "folder", "grouping", "logical project grouping", "general"]],
      ["compact-sidebar", "Compact sidebar", ["sidebar", "density", "navigation", "compact project navigation", "general"]],
    ],
    General: [
      ["project-name", "Name", ["rename project", "project name"]],
      ["project-icon", "Project icon", ["image", "symbol"]],
      ["project-colour", "Project colour", ["color", "tint"]],
      ["project-colour-emphasis", "Colour shows on", ["color", "tint"]],
      ["project-pin", "Pin to top", ["favourite", "favorite", "pin project"]],
    ],
    "New chats": [
      ["project-model", "Model", ["default model", "project model", "override"]],
      ["project-workspace", "Where new chats run", ["worktree", "checkout", "branch", "workspace"]],
      ["project-default-access", "Default access", ["access", "full access", "supervised", "auto-accept edits", "permissions"]],
      ["project-browser-access", "Agent browser access", ["preview browser", "browser"]],
      ["project-spend-limit", "Claude spend limit per turn", ["budget", "cost", "usd", "limit", "token"]],
    ],
    Checkout: [
      ["project-grouping-override", "Group this project", ["repository", "grouping"]],
      ["project-auto-pull", "Automatically pull", ["git", "branch", "pull", "source control"]],
      ["project-actions", "Actions", ["commands", "scripts", "project actions"]],
      ["project-repository-limit", "Repository display limit", ["repositories", "nested", "sidebar", "limit", "advanced"]],
    ],
    "Danger zone": [
      ["project-remove", "Remove project", ["delete project"]],
    ],
  }),
  section("agents", "Agents", {
    Providers: [
      ["provider-accounts", "Providers", ["agents", "accounts", "connect", "sign in", "refresh", "codex", "claude", "model", "connections"]],
      ["provider-display-name", "Account name", ["alias", "display name", "provider"]],
      ["provider-binary-path", "Executable", ["binary path", "codex path", "use automatic", "cli"]],
      ["provider-updates", "Provider updates", ["maintenance", "upgrade", "update", "version"]],
    ],
    "Custom backends": [
      ["model-backends", "Custom backends", ["model backends", "backends", "api key", "token", "openai compatible", "profiles", "endpoint", "model"]],
    ],
  }),
  section("devices", "Devices & integrations", {
    "Private Connect": [
      ["private-connect", "Private Connect", ["phone", "remote", "tailscale", "pairing", "connections", "mobile"]],
      ["paired-devices", "Paired devices", ["phone access", "devices", "connections", "revoke"]],
    ],
    Snapshots: [
      ["snapshots-enabled", "Window snapshots", ["screenshot", "capture", "snapshot"]],
      ["snapshot-access", "Capture access", ["permissions", "accessibility", "screen recording", "screenshot", "snapshot"]],
    ],
    Discord: [
      ["discord-repository", "Repository URL", ["github", "gitlab", "release", "discord"]],
      ["discord-webhook", "Webhook URL", ["discord webhook", "discord", "token"]],
      ["discord-release", "Post release to Discord", ["post release", "generate", "announce", "release info", "discord"]],
    ],
  }),
  section("data", "Data", {
    Storage: [
      ["resource-health", "Local resource health", ["memory", "storage", "disk", "browser cache", "clear cache", "where my data is", "storage use", "archive"]],
      ["database-backup", "Full local database backup", ["backup", "backups", "database", "storage", "archive"]],
      ["attachment-storage", "Attachment storage", ["disk", "files", "storage", "archive"]],
      ["attachment-storage-limit", "Attachment storage limit", ["budget", "disk", "storage", "limit"]],
      ["attachment-auto-remove", "Free space automatically when full", ["cleanup", "evict", "disk", "storage"]],
      ["attachment-remove-oldest", "Remove oldest files", ["cleanup", "delete attachments", "disk", "storage"]],
    ],
    "Export and import": [
      ["recovery-export", "Portable conversation recovery export", ["import", "export", "backup", "recovery", "archive"]],
    ],
    "Archived chats": [
      ["archived-threads", "Archived chats", ["restore chat", "archive", "unarchive", "archived threads"]],
    ],
    Defaults: [
      ["restore-defaults", "Restore defaults", ["reset", "factory", "defaults", "general"]],
    ],
  }),
  section("help", "Help", {
    "Report an issue": [
      ["report-issue", "Report an issue", ["bug", "feedback", "github issue", "support"]],
    ],
    Diagnostics: [
      ["diagnostics-incidents", "Diagnostics", ["errors", "incidents", "problems", "export diagnostics", "logs"]],
    ],
    Support: [
      ["runtime-diagnostics", "Runtime diagnostics", ["support summary", "logs", "reveal log folder", "support"]],
      ["welcome-guide", "Welcome guide", ["tour", "onboarding", "help"]],
    ],
    "About and updates": [
      ["app-updates", "About and updates", ["version", "update", "check for updates", "release", "release notes", "canary", "general"]],
    ],
  }),
];

export const SETTINGS_ROWS: readonly SettingsRowMetadata[] = SETTINGS_SECTION_ROWS.flatMap(({ rows }) => rows);

export function settingsSectionRows(id: SettingsSection): SettingsSectionRows {
  return SETTINGS_SECTION_ROWS.find((entry) => entry.id === id) ?? SETTINGS_SECTION_ROWS[0]!;
}

export function isProjectSettingsRow(row: SettingsRowMetadata): boolean {
  return row.sectionId === "projects" && row.group !== "All projects";
}
