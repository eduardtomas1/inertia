export const EDITOR_IDS = [
  "cursor",
  "trae",
  "kiro",
  "vscode",
  "vscode-insiders",
  "vscodium",
  "zed",
  "antigravity",
  "idea",
  "aqua",
  "clion",
  "datagrip",
  "dataspell",
  "goland",
  "phpstorm",
  "pycharm",
  "rider",
  "rubymine",
  "rustrover",
  "webstorm",
] as const;

export type EditorId = (typeof EDITOR_IDS)[number];

export const PREFERRED_EDITOR_VALUES = ["system", "ask", ...EDITOR_IDS] as const;

export type PreferredEditor = (typeof PREFERRED_EDITOR_VALUES)[number];

export const DEFAULT_PREFERRED_EDITOR: PreferredEditor = "system";

export interface DetectedEditor {
  readonly id: EditorId;
  readonly label: string;
}

export interface EditorPosition {
  readonly line?: number;
  readonly column?: number;
}

export interface GetAvailableEditorsRequest {
  readonly refresh?: boolean;
}

export const MAX_EDITOR_POSITION_VALUE = 1_000_000_000;

export const EDITOR_LABELS: Readonly<Record<EditorId, string>> = {
  cursor: "Cursor",
  trae: "Trae",
  kiro: "Kiro",
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  vscodium: "VSCodium",
  zed: "Zed",
  antigravity: "Antigravity",
  idea: "IntelliJ IDEA",
  aqua: "Aqua",
  clion: "CLion",
  datagrip: "DataGrip",
  dataspell: "DataSpell",
  goland: "GoLand",
  phpstorm: "PhpStorm",
  pycharm: "PyCharm",
  rider: "Rider",
  rubymine: "RubyMine",
  rustrover: "RustRover",
  webstorm: "WebStorm",
};

export function isEditorId(value: unknown): value is EditorId {
  return typeof value === "string" && Object.hasOwn(EDITOR_LABELS, value);
}

export function isPreferredEditor(value: unknown): value is PreferredEditor {
  return value === "system" || value === "ask" || isEditorId(value);
}

export function parsePreferredEditor(value: unknown): PreferredEditor {
  return isPreferredEditor(value) ? value : DEFAULT_PREFERRED_EDITOR;
}

export function editorLabel(id: EditorId): string {
  return EDITOR_LABELS[id] ?? id;
}

export function isPositiveEditorInt(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_EDITOR_POSITION_VALUE;
}
