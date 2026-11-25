import {
  isPositiveEditorInt,
  type EditorId,
  type EditorPosition,
  type GetAvailableEditorsRequest,
} from "./editor-ids";

export {
  DEFAULT_PREFERRED_EDITOR,
  EDITOR_IDS,
  EDITOR_LABELS,
  MAX_EDITOR_POSITION_VALUE,
  PREFERRED_EDITOR_VALUES,
  editorLabel,
  isEditorId,
  isPositiveEditorInt,
  isPreferredEditor,
  parsePreferredEditor,
  type DetectedEditor,
  type EditorId,
  type EditorPosition,
  type GetAvailableEditorsRequest,
  type PreferredEditor,
} from "./editor-ids";

export type EditorLaunchStyle = "goto" | "direct-path" | "line-column";

export type EditorPlatformOs = "darwin" | "win32" | "linux";

export interface EditorDefinition {
  readonly id: EditorId;
  readonly label: string;
  readonly launchStyle: EditorLaunchStyle;
  readonly commands: Readonly<Record<EditorPlatformOs, readonly [string, ...string[]]>>;
  readonly baseArgs?: readonly string[];
  readonly bundleBaseArgs?: Partial<Record<EditorPlatformOs, readonly string[]>>;
  readonly installPaths: Readonly<Record<EditorPlatformOs, readonly string[]>>;
  readonly macAppNames: readonly string[];
  readonly windowsInstallNames: readonly string[];
  readonly jetbrains?: boolean;
}

function vscodeFamilyInstallPaths(
  command: string,
  macAppName: string,
  windowsDirNames: readonly string[],
  linuxCommands: readonly string[] = [command],
): Readonly<Record<EditorPlatformOs, readonly string[]>> {
  return {
    darwin: [
      `/Applications/${macAppName}.app/Contents/Resources/app/bin/${command}`,
      `/Applications/${macAppName}.app/Contents/Resources/app/bin/code`,
      `$HOME/Applications/${macAppName}.app/Contents/Resources/app/bin/${command}`,
      `$HOME/Applications/${macAppName}.app/Contents/Resources/app/bin/code`,
    ],
    win32: windowsDirNames.flatMap((dirName) => [
      `$LOCALAPPDATA/Programs/${dirName}/resources/app/bin/${command}.cmd`,
      `$LOCALAPPDATA/Programs/${dirName}/resources/app/bin/code.cmd`,
      `$LOCALAPPDATA/Programs/${dirName}/bin/${command}.cmd`,
      `$LOCALAPPDATA/Programs/${dirName}/bin/code.cmd`,
      `$PROGRAMFILES/${dirName}/resources/app/bin/${command}.cmd`,
      `$PROGRAMFILES/${dirName}/resources/app/bin/code.cmd`,
      `$PROGRAMFILES/${dirName}/bin/${command}.cmd`,
      `$PROGRAMFILES/${dirName}/bin/code.cmd`,
      `$PROGRAMFILES_X86/${dirName}/bin/${command}.cmd`,
      `$PROGRAMW6432/${dirName}/bin/${command}.cmd`,
    ]),
    linux: linuxCommands.flatMap((name) => [
      `$HOME/.local/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
      `/snap/bin/${name}`,
    ]),
  };
}

function jetbrainsInstallPaths(
  command: string,
  macAppNames: readonly string[],
  windowsNames: readonly string[],
): Readonly<Record<EditorPlatformOs, readonly string[]>> {
  return {
    darwin: [
      ...macAppNames.flatMap((name) => [
        `/Applications/${name}.app/Contents/MacOS/${command}`,
        `$HOME/Applications/${name}.app/Contents/MacOS/${command}`,
      ]),
      `$HOME/Library/Application Support/JetBrains/Toolbox/scripts/${command}`,
    ],
    win32: [
      `$LOCALAPPDATA/JetBrains/Toolbox/scripts/${command}.cmd`,
      ...windowsNames.flatMap((name) => [
        `$LOCALAPPDATA/Programs/${name}/bin/${command}64.exe`,
        `$LOCALAPPDATA/Programs/${name}/bin/${command}.exe`,
        `$PROGRAMFILES/JetBrains/${name}/bin/${command}64.exe`,
        `$PROGRAMFILES/JetBrains/${name}/bin/${command}.exe`,
      ]),
    ],
    linux: [
      `$HOME/.local/bin/${command}`,
      `/usr/local/bin/${command}`,
      `/usr/bin/${command}`,
      `/snap/bin/${command}`,
      `$XDG_DATA_HOME/JetBrains/Toolbox/scripts/${command}`,
    ],
  };
}

function jetbrainsEditor(
  id: EditorId,
  label: string,
  command: string,
  names: readonly string[] = [label],
): EditorDefinition {
  return {
    id,
    label,
    launchStyle: "line-column",
    commands: {
      darwin: [command],
      win32: [command],
      linux: [command],
    },
    installPaths: jetbrainsInstallPaths(command, names, names),
    macAppNames: names,
    windowsInstallNames: names,
    jetbrains: true,
  };
}

export const EDITORS: readonly EditorDefinition[] = [
  {
    id: "cursor",
    label: "Cursor",
    launchStyle: "goto",
    commands: { darwin: ["cursor"], win32: ["cursor"], linux: ["cursor"] },
    baseArgs: ["--classic"],
    installPaths: vscodeFamilyInstallPaths("cursor", "Cursor", ["cursor", "Cursor"]),
    macAppNames: ["Cursor"],
    windowsInstallNames: ["cursor", "Cursor"],
  },
  {
    id: "trae",
    label: "Trae",
    launchStyle: "goto",
    commands: { darwin: ["trae"], win32: ["trae"], linux: ["trae"] },
    installPaths: vscodeFamilyInstallPaths("trae", "Trae", ["Trae"]),
    macAppNames: ["Trae"],
    windowsInstallNames: ["Trae"],
  },
  {
    id: "kiro",
    label: "Kiro",
    launchStyle: "goto",
    commands: { darwin: ["kiro"], win32: ["kiro"], linux: ["kiro"] },
    baseArgs: ["ide"],
    bundleBaseArgs: { darwin: [], win32: [] },
    installPaths: vscodeFamilyInstallPaths("kiro", "Kiro", ["Kiro"]),
    macAppNames: ["Kiro"],
    windowsInstallNames: ["Kiro"],
  },
  {
    id: "vscode",
    label: "VS Code",
    launchStyle: "goto",
    commands: { darwin: ["code"], win32: ["code"], linux: ["code"] },
    installPaths: vscodeFamilyInstallPaths("code", "Visual Studio Code", ["Microsoft VS Code"]),
    macAppNames: ["Visual Studio Code"],
    windowsInstallNames: ["Microsoft VS Code"],
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    launchStyle: "goto",
    commands: {
      darwin: ["code-insiders"],
      win32: ["code-insiders"],
      linux: ["code-insiders"],
    },
    installPaths: vscodeFamilyInstallPaths(
      "code-insiders",
      "Visual Studio Code - Insiders",
      ["Microsoft VS Code Insiders"],
    ),
    macAppNames: ["Visual Studio Code - Insiders"],
    windowsInstallNames: ["Microsoft VS Code Insiders"],
  },
  {
    id: "vscodium",
    label: "VSCodium",
    launchStyle: "goto",
    commands: { darwin: ["codium"], win32: ["codium"], linux: ["codium"] },
    installPaths: vscodeFamilyInstallPaths("codium", "VSCodium", ["VSCodium"]),
    macAppNames: ["VSCodium"],
    windowsInstallNames: ["VSCodium"],
  },
  {
    id: "zed",
    label: "Zed",
    launchStyle: "direct-path",
    commands: {
      darwin: ["zed"],
      win32: ["zed"],
      linux: ["zeditor", "zed"],
    },
    installPaths: {
      darwin: [
        "/Applications/Zed.app/Contents/MacOS/cli",
        "$HOME/Applications/Zed.app/Contents/MacOS/cli",
      ],
      win32: [
        "$LOCALAPPDATA/Programs/Zed/bin/zed.exe",
        "$LOCALAPPDATA/Programs/Zed/zed.exe",
        "$PROGRAMFILES/Zed/bin/zed.exe",
        "$PROGRAMFILES/Zed/zed.exe",
        "$PROGRAMW6432/Zed/bin/zed.exe",
        "$PROGRAMW6432/Zed/zed.exe",
      ],
      linux: [
        "$HOME/.local/bin/zeditor",
        "/usr/local/bin/zeditor",
        "/usr/bin/zeditor",
        "/snap/bin/zeditor",
        "$HOME/.local/bin/zed",
        "/usr/local/bin/zed",
        "/usr/bin/zed",
        "/snap/bin/zed",
      ],
    },
    macAppNames: ["Zed"],
    windowsInstallNames: ["Zed"],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    launchStyle: "goto",
    commands: {
      darwin: ["antigravity-ide", "agy-ide"],
      win32: ["antigravity-ide", "agy-ide"],
      linux: ["antigravity-ide", "agy-ide"],
    },
    installPaths: vscodeFamilyInstallPaths(
      "antigravity-ide",
      "Antigravity IDE",
      ["Antigravity IDE", "Antigravity"],
      ["antigravity-ide", "agy-ide"],
    ),
    macAppNames: ["Antigravity IDE"],
    windowsInstallNames: ["Antigravity IDE", "Antigravity"],
  },
  jetbrainsEditor("idea", "IntelliJ IDEA", "idea", [
    "IntelliJ IDEA",
    "IntelliJ IDEA CE",
    "IntelliJ IDEA Ultimate",
  ]),
  jetbrainsEditor("aqua", "Aqua", "aqua"),
  jetbrainsEditor("clion", "CLion", "clion"),
  jetbrainsEditor("datagrip", "DataGrip", "datagrip"),
  jetbrainsEditor("dataspell", "DataSpell", "dataspell"),
  jetbrainsEditor("goland", "GoLand", "goland"),
  jetbrainsEditor("phpstorm", "PhpStorm", "phpstorm"),
  jetbrainsEditor("pycharm", "PyCharm", "pycharm", ["PyCharm", "PyCharm CE"]),
  jetbrainsEditor("rider", "Rider", "rider", ["Rider", "JetBrains Rider"]),
  jetbrainsEditor("rubymine", "RubyMine", "rubymine"),
  jetbrainsEditor("rustrover", "RustRover", "rustrover"),
  jetbrainsEditor("webstorm", "WebStorm", "webstorm"),
] as const;

const EDITORS_BY_ID: ReadonlyMap<string, EditorDefinition> = new Map(
  EDITORS.map((editor) => [editor.id, editor]),
);

export function editorById(id: string): EditorDefinition | undefined {
  return EDITORS_BY_ID.get(id);
}

export function validateEditorPosition(
  position?: EditorPosition,
): { ok: true; line?: number; column?: number } | { ok: false; error: string } {
  if (position === undefined) return { ok: true };
  if (position.line !== undefined && !isPositiveEditorInt(position.line)) {
    return { ok: false, error: "Line number must be a positive integer." };
  }
  if (position.column !== undefined) {
    if (position.line === undefined) {
      return { ok: false, error: "Column number requires a line number." };
    }
    if (!isPositiveEditorInt(position.column)) {
      return { ok: false, error: "Column number must be a positive integer." };
    }
  }
  return {
    ok: true,
    ...(position.line !== undefined ? { line: position.line } : {}),
    ...(position.column !== undefined ? { column: position.column } : {}),
  };
}

export function parseGetAvailableEditorsRequest(value: unknown): GetAvailableEditorsRequest | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length === 0) return {};
  if (keys.length === 1 && keys[0] === "refresh" && typeof candidate.refresh === "boolean") {
    return { refresh: candidate.refresh };
  }
  return null;
}

export function parseSourceLocationPosition(
  location: string,
): { line: number; column?: number } | null {
  const colonMatch = /^:([1-9]\d{0,8})(?::([1-9]\d{0,8}))?(?:-([1-9]\d{0,8})(?::([1-9]\d{0,8}))?)?$/u.exec(location);
  const hashMatch = colonMatch
    ? null
    : /^#L([1-9]\d{0,8})(?:C([1-9]\d{0,8}))?(?:-L?([1-9]\d{0,8})(?:C([1-9]\d{0,8}))?)?$/iu.exec(location);
  const match = colonMatch ?? hashMatch;
  if (!match?.[1]) return null;
  const line = Number(match[1]);
  const column = match[2] ? Number(match[2]) : undefined;
  const validated = validateEditorPosition({ line, ...(column !== undefined ? { column } : {}) });
  if (!validated.ok || validated.line === undefined) return null;
  return {
    line: validated.line,
    ...(validated.column !== undefined ? { column: validated.column } : {}),
  };
}

export interface BuildEditorArgumentsOptions {
  readonly target: string;
  readonly isDirectory?: boolean;
  readonly projectRoot?: string;
  readonly line?: number;
  readonly column?: number;
  readonly baseArgs?: readonly string[];
  readonly literalPath?: boolean;
}

function hasNumericColonSegment(target: string): boolean {
  const withoutDrive = target.replace(/^[A-Za-z]:/u, "");
  if (!withoutDrive.includes(":")) return false;
  return withoutDrive.split(":").slice(1).some(
    (segment) => segment.length > 0 && !Number.isNaN(Number(segment)),
  );
}

export function buildEditorArguments(
  editor: EditorDefinition,
  options: BuildEditorArgumentsOptions,
): string[] {
  const position = validateEditorPosition({
    ...(options.line !== undefined ? { line: options.line } : {}),
    ...(options.column !== undefined ? { column: options.column } : {}),
  });
  if (!position.ok) {
    throw new Error(position.error);
  }
  const base = [...(options.baseArgs ?? editor.baseArgs ?? [])];
  const target = options.target;
  const isDirectory = options.isDirectory === true;

  switch (editor.launchStyle) {
    case "goto": {
      if (isDirectory) return [...base, "--new-window", target];
      if (position.line === undefined) return [...base, target];
      if (options.literalPath || hasNumericColonSegment(target)) {
        return [...base, target];
      }
      const positioned = position.column !== undefined
        ? `${target}:${position.line}:${position.column}`
        : `${target}:${position.line}`;
      return [...base, "--goto", positioned];
    }
    case "direct-path": {
      if (isDirectory || position.line === undefined) return [...base, target];
      if (options.literalPath || /:\d+(?=:|$)/u.test(target.replace(/^[A-Za-z]:/u, ""))) {
        return [...base, target];
      }
      const positioned = position.column !== undefined
        ? `${target}:${position.line}:${position.column}`
        : `${target}:${position.line}`;
      return [...base, positioned];
    }
    case "line-column": {
      if (isDirectory || position.line === undefined) return [...base, target];
      return [
        ...base,
        ...(options.projectRoot ? [options.projectRoot] : []),
        "--line",
        String(position.line),
        ...(position.column !== undefined
          ? ["--column", String(Math.max(0, position.column - 1))]
          : []),
        target,
      ];
    }
  }
}
