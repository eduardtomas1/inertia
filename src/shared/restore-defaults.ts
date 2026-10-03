import { defaultSettings, type AppSettings, type AppSettingsUpdate } from "./contracts/app";
import { parseCompletionSoundSettings } from "./completion-sound";

export const RESTORE_DEFAULTS_RESETS = [
  { label: "appearance", keys: ["theme", "colorTheme", "interfaceScale", "responseDensity", "workingIndicator"] },
  {
    label: "chat and notification preferences",
    keys: [
      "showThinking", "autoCollapseWorkLog", "autoScrollToFinalAnswer", "showTimestamps", "showChangedFileSummaries",
      "defaultCodeWrap", "autoOpenPlan", "confirmDestructiveActions", "usageDisplayMode", "wrapDiffs", "ignoreWhitespace",
      "terminalFontSize", "desktopNotifications", "completionSound", "projectGrouping", "compactSidebar",
    ],
  },
  { label: "keyboard shortcuts", keys: ["keybindings"] },
  {
    label: "the new-chat defaults, including a custom backend chosen for new chats",
    keys: ["defaultProvider", "defaultModel", "defaultReasoningEffort", "defaultInteractionMode", "defaultAccessMode", "newThreadMode"],
  },
  { label: "provider display names", keys: ["providerIdentityLabels"] },
  { label: "the Codex executable", keys: ["codexBinaryPath"] },
  { label: "the Discord repository URL", keys: ["discordReleaseRepositoryUrl"] },
  { label: "attachment storage limits", keys: ["attachmentStorageGiB", "autoRemoveOldAttachments"] },
] as const satisfies ReadonlyArray<{ label: string; keys: ReadonlyArray<keyof AppSettings> }>;

export const RESTORE_DEFAULTS_KEEPS = [
  "imported sounds",
  "projects and their overrides",
  "custom backend profiles",
  "window snapshots and their shortcut",
  "the desktop mascot",
  "Private Connect",
  "the Discord webhook",
] as const;

function sentenceList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export const RESTORE_DEFAULTS_SCOPE = `Resets ${sentenceList(RESTORE_DEFAULTS_RESETS.map(({ label }) => label))}. Keeps ${sentenceList(RESTORE_DEFAULTS_KEEPS)}.`;

export const RESTORE_DEFAULTS_CONFIRMATION = `Restore defaults? ${RESTORE_DEFAULTS_SCOPE}`;

export function restoredDefaultSettings(current: Pick<AppSettings, "completionSound">): AppSettingsUpdate {
  return {
    ...defaultSettings,
    completionSound: {
      ...defaultSettings.completionSound,
      library: parseCompletionSoundSettings(current.completionSound).library,
    },
  };
}
