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

const LEGACY_SETTINGS_SECTIONS = {
  general: { section: "appearance" },
  snapshots: { section: "devices", anchor: "snapshots-enabled" },
  providers: { section: "agents" },
  backends: { section: "agents", anchor: "model-backends" },
  connections: { section: "devices", anchor: "private-connect" },
  discord: { section: "devices", anchor: "discord-repository" },
  diagnostics: { section: "help", anchor: "diagnostics-incidents" },
  source: { section: "chats", anchor: "wrap-diffs" },
  keybindings: { section: "keyboard" },
  support: { section: "help", anchor: "report-issue" },
  archive: { section: "data" },
} as const satisfies Record<string, { section: SettingsSection; anchor?: string }>;

export type LegacySettingsSection = keyof typeof LEGACY_SETTINGS_SECTIONS;

export interface DiagnosticSelection {
  incidentId?: string;
  turnId?: string;
  requestId?: string;
}

export interface SettingsTarget {
  section: SettingsSection;
  anchor?: string;
  projectId?: string;
  profileId?: string;
  selection?: DiagnosticSelection;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ANCHOR = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const TARGET_KEYS = new Set(["section", "anchor", "projectId", "profileId", "selection"]);
const SELECTION_KEYS = new Set(["incidentId", "turnId", "requestId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

function isLegacySettingsSection(value: unknown): value is LegacySettingsSection {
  return typeof value === "string" && Object.hasOwn(LEGACY_SETTINGS_SECTIONS, value);
}

export function legacySettingsTarget(
  section: SettingsSection | LegacySettingsSection,
): { section: SettingsSection; anchor?: string } {
  return isLegacySettingsSection(section) ? { ...LEGACY_SETTINGS_SECTIONS[section] } : { section };
}

function parseSelection(value: unknown): DiagnosticSelection | null {
  if (!isRecord(value)) return null;
  const selection: DiagnosticSelection = {};
  for (const [key, id] of Object.entries(value)) {
    if (!SELECTION_KEYS.has(key) || typeof id !== "string" || !UUID.test(id)) return null;
    Object.assign(selection, { [key]: id });
  }
  return selection;
}

export function parseSettingsTarget(value: unknown): SettingsTarget | null {
  if (!isRecord(value) || !(isSettingsSection(value.section) || isLegacySettingsSection(value.section))) return null;
  if (Object.keys(value).some((key) => !TARGET_KEYS.has(key))) return null;
  const target: SettingsTarget = legacySettingsTarget(value.section);
  if (value.anchor !== undefined) {
    if (typeof value.anchor !== "string" || !ANCHOR.test(value.anchor)) return null;
    target.anchor = value.anchor;
  }
  if (value.projectId !== undefined) {
    if (typeof value.projectId !== "string" || !UUID.test(value.projectId)) return null;
    target.projectId = value.projectId;
  }
  if (value.profileId !== undefined) {
    if (typeof value.profileId !== "string" || !PROFILE_ID.test(value.profileId)) return null;
    target.profileId = value.profileId;
  }
  if (value.selection !== undefined) {
    const selection = target.section === "help" ? parseSelection(value.selection) : null;
    if (!selection) return null;
    target.selection = selection;
  }
  return target;
}
