export const COMPLETION_SOUND_IPC = "inertia:completion-sound";

export const BUILT_IN_COMPLETION_SOUNDS = ["chime", "glass", "marimba", "bloom", "pop", "bell"] as const;

export type BuiltInCompletionSound = typeof BUILT_IN_COMPLETION_SOUNDS[number];

export const COMPLETION_SOUND_EXTENSIONS = ["wav", "mp3", "ogg", "oga", "opus", "flac", "m4a", "aac", "webm"] as const;

export type CompletionSoundExtension = typeof COMPLETION_SOUND_EXTENSIONS[number];

export type CompletionSoundFile = `${string}.${CompletionSoundExtension}`;

export type CompletionSoundChoice = BuiltInCompletionSound | CompletionSoundFile;

export const COMPLETION_SOUND_FILE_PATTERN = new RegExp(`^[0-9a-f]{16}\\.(?:${COMPLETION_SOUND_EXTENSIONS.join("|")})$`, "u");

export const COMPLETION_SOUND_MAX_BYTES = 1024 * 1024;

export const COMPLETION_SOUND_MAX_PLAY_SECONDS = 3;

export const COMPLETION_SOUND_LIBRARY_MAX = 8;

export const COMPLETION_SOUND_NAME_MAX_LENGTH = 48;

export const COMPLETION_SOUND_LONG_RUN_MIN_SECONDS = 5;

export const COMPLETION_SOUND_LONG_RUN_MAX_SECONDS = 7200;

export const COMPLETION_SOUND_JSON_MAX_LENGTH = 2048;

export interface CustomCompletionSound {
  file: CompletionSoundFile;
  name: string;
}

export interface CompletionSoundSettings {
  enabled: boolean;
  sound: CompletionSoundChoice;
  library: CustomCompletionSound[];
  longRunsOnly: boolean;
  longRunSeconds: number;
}

export const DEFAULT_COMPLETION_SOUND: Readonly<CompletionSoundSettings> = Object.freeze({
  enabled: false,
  sound: "chime",
  library: [],
  longRunsOnly: false,
  longRunSeconds: 60,
});

export type CompletionSoundAction = "import" | "read" | "remove";

export type CompletionSoundImport =
  | { status: "imported"; sound: CustomCompletionSound }
  | { status: "cancelled" }
  | { status: "rejected"; message: string };

const SETTINGS_KEYS = Object.keys(DEFAULT_COMPLETION_SOUND).sort().join("\0");

export function isBuiltInCompletionSound(value: unknown): value is BuiltInCompletionSound {
  return typeof value === "string" && (BUILT_IN_COMPLETION_SOUNDS as readonly string[]).includes(value);
}

export function isCompletionSoundFile(value: unknown): value is CompletionSoundFile {
  return typeof value === "string" && COMPLETION_SOUND_FILE_PATTERN.test(value);
}

export function completionSoundName(value: string): string {
  const name = [...value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/gu, " ").trim()]
    .slice(0, COMPLETION_SOUND_NAME_MAX_LENGTH).join("").trim();
  return name || "My sound";
}

export function isCustomCompletionSound(value: unknown): value is CustomCompletionSound {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join("\0") === "file\0name"
    && isCompletionSoundFile(record.file)
    && typeof record.name === "string"
    && record.name === completionSoundName(record.name);
}

export function isCompletionSoundLibrary(value: unknown): value is CustomCompletionSound[] {
  return Array.isArray(value)
    && value.length <= COMPLETION_SOUND_LIBRARY_MAX
    && value.every(isCustomCompletionSound)
    && new Set(value.map(({ file }) => file)).size === value.length;
}

export function isLongRunSeconds(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= COMPLETION_SOUND_LONG_RUN_MIN_SECONDS
    && value <= COMPLETION_SOUND_LONG_RUN_MAX_SECONDS;
}

function parseLibrary(value: unknown): CustomCompletionSound[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const library: CustomCompletionSound[] = [];
  for (const entry of value) {
    if (library.length >= COMPLETION_SOUND_LIBRARY_MAX) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { file, name } = entry as Record<string, unknown>;
    if (!isCompletionSoundFile(file) || typeof name !== "string" || seen.has(file)) continue;
    seen.add(file);
    library.push({ file, name: completionSoundName(name) });
  }
  return library;
}

export function parseCompletionSoundSettings(value: unknown): CompletionSoundSettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const library = parseLibrary(record.library);
  const sound = isBuiltInCompletionSound(record.sound)
    || (isCompletionSoundFile(record.sound) && library.some(({ file }) => file === record.sound))
    ? record.sound as CompletionSoundChoice
    : DEFAULT_COMPLETION_SOUND.sound;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_COMPLETION_SOUND.enabled,
    sound,
    library,
    longRunsOnly: typeof record.longRunsOnly === "boolean" ? record.longRunsOnly : DEFAULT_COMPLETION_SOUND.longRunsOnly,
    longRunSeconds: isLongRunSeconds(record.longRunSeconds) ? record.longRunSeconds : DEFAULT_COMPLETION_SOUND.longRunSeconds,
  };
}

export function isCompletionSoundSettings(value: unknown): value is CompletionSoundSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join("\0") !== SETTINGS_KEYS) return false;
  const record = value as Record<string, unknown>;
  if (!isCompletionSoundLibrary(record.library)) return false;
  const parsed = parseCompletionSoundSettings(value);
  return parsed.enabled === record.enabled
    && parsed.sound === record.sound
    && parsed.longRunsOnly === record.longRunsOnly
    && parsed.longRunSeconds === record.longRunSeconds;
}

export function parseCompletionSoundJson(value: string | null | undefined): CompletionSoundSettings {
  if (!value || value.length > COMPLETION_SOUND_JSON_MAX_LENGTH) return { ...DEFAULT_COMPLETION_SOUND, library: [] };
  try {
    return parseCompletionSoundSettings(JSON.parse(value));
  } catch {
    return { ...DEFAULT_COMPLETION_SOUND, library: [] };
  }
}

export function completionSoundDue(
  settings: Pick<CompletionSoundSettings, "enabled" | "longRunsOnly" | "longRunSeconds">,
  durationMs: number | null,
): boolean {
  if (!settings.enabled) return false;
  if (!settings.longRunsOnly) return true;
  return durationMs !== null && durationMs >= settings.longRunSeconds * 1000;
}
