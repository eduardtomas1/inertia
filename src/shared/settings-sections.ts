export const SETTINGS_SECTION_IDS = [
  "appearance",
  "chats",
  "notifications",
  "keyboard",
  "projects",
  "agents",
  "devices",
  "data",
  "help",
] as const;

export type SettingsSection = typeof SETTINGS_SECTION_IDS[number];
