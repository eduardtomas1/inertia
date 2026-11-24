import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { buildWindowsCommandShimInvocation } from "../../src/node/windows-command-shim";
import { parseOpenProjectPathRequest } from "../../src/shared/desktop";
import {
  buildEditorArguments,
  editorById,
  parseGetAvailableEditorsRequest,
  parseSourceLocationPosition,
  validateEditorPosition,
} from "../../src/shared/editors";
import {
  EditorLauncher,
  resolveEditorExecutable,
  type EditorFileStats,
  type EditorLauncherDependencies,
  type EditorSpawnRequest,
} from "../../src/main/editor-launcher";
import { openDesktopLink } from "../../src/main/external-link-open";
import { userWindowsCurrentDirectorySearch } from "../../src/node/windows-current-directory-search";

const fileStat: EditorFileStats = {
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
};

const dirStat: EditorFileStats = {
  isFile: () => false,
  isDirectory: () => true,
  isSymbolicLink: () => false,
};

const symlinkStat: EditorFileStats = {
  isFile: () => false,
  isDirectory: () => false,
  isSymbolicLink: () => true,
};

function makeFakeFs(options: {
  platform: NodeJS.Platform;
  files?: readonly string[];
  dirs?: readonly string[];
  symlinks?: readonly string[];
  nonExecutable?: readonly string[];
  realpaths?: Record<string, string>;
  entries?: Record<string, readonly string[]>;
}): Pick<EditorLauncherDependencies, "lstat" | "stat" | "accessExecutable" | "readdir" | "realpath"> {
  const norm = (value: string) => (
    options.platform === "win32" ? value.replaceAll("/", "\\").toLocaleLowerCase("en-US") : value
  );
  const files = new Set((options.files ?? []).map(norm));
  const dirs = new Set((options.dirs ?? []).map(norm));
  const symlinks = new Set((options.symlinks ?? []).map(norm));
  const nonExecutable = new Set((options.nonExecutable ?? []).map(norm));
  const realpaths = new Map(Object.entries(options.realpaths ?? {}).map(([k, v]) => [norm(k), v]));
  const entries = new Map(Object.entries(options.entries ?? {}).map(([k, v]) => [norm(k), [...v]]));

  return {
    lstat: async (filePath) => {
      const key = norm(filePath);
      if (symlinks.has(key)) return symlinkStat;
      if (files.has(key)) return fileStat;
      if (dirs.has(key)) return dirStat;
      return null;
    },
    stat: async (filePath) => {
      const key = norm(filePath);
      if (files.has(key)) return fileStat;
      if (dirs.has(key)) return dirStat;
      return null;
    },
    accessExecutable: async (filePath) => {
      const key = norm(filePath);
      return files.has(key) && !nonExecutable.has(key);
    },
    readdir: async (directoryPath) => entries.get(norm(directoryPath)) ?? [],
    realpath: async (filePath) => realpaths.get(norm(filePath)) ?? filePath,
  };
}

describe("editor argument building", () => {
  it("builds VS Code family arguments for files, positions, and folders", () => {
    const vscode = editorById("vscode")!;
    expect(buildEditorArguments(vscode, { target: "/repo/src/app.ts" })).toEqual(["/repo/src/app.ts"]);
    expect(buildEditorArguments(vscode, { target: "/repo/src/app.ts", line: 42 })).toEqual([
      "--goto",
      "/repo/src/app.ts:42",
    ]);
    expect(buildEditorArguments(vscode, { target: "/repo/src/app.ts", line: 42, column: 7 })).toEqual([
      "--goto",
      "/repo/src/app.ts:42:7",
    ]);
    expect(buildEditorArguments(vscode, { target: "/repo/build:2026", isDirectory: true })).toEqual([
      "--new-window",
      "/repo/build:2026",
    ]);
    expect(buildEditorArguments(vscode, { target: "/repo/foo:123", line: 4 })).toEqual([
      "/repo/foo:123",
    ]);
    const cursor = editorById("cursor")!;
    expect(buildEditorArguments(cursor, { target: "/repo/src/app.ts", line: 10 })).toEqual([
      "--classic",
      "--goto",
      "/repo/src/app.ts:10",
    ]);
  });

  it("builds Zed direct-path arguments and avoids colon collisions", () => {
    const zed = editorById("zed")!;
    expect(buildEditorArguments(zed, { target: "/repo/src/app.ts" })).toEqual(["/repo/src/app.ts"]);
    expect(buildEditorArguments(zed, { target: "/repo/src/app.ts", line: 12 })).toEqual([
      "/repo/src/app.ts:12",
    ]);
    expect(buildEditorArguments(zed, { target: "/repo/src/app.ts", line: 12, column: 3 })).toEqual([
      "/repo/src/app.ts:12:3",
    ]);
    expect(buildEditorArguments(zed, { target: "/repo/src/app.ts", isDirectory: true, line: 12 })).toEqual([
      "/repo/src/app.ts",
    ]);
    expect(buildEditorArguments(zed, { target: "/repo/log:10", line: 5 })).toEqual(["/repo/log:10"]);
  });

  it("builds JetBrains line-column arguments with 0-indexed columns and project root", () => {
    const idea = editorById("idea")!;
    expect(buildEditorArguments(idea, {
      target: "/repo/src/Main.kt",
      projectRoot: "/repo",
      line: 25,
      column: 8,
    })).toEqual(["/repo", "--line", "25", "--column", "7", "/repo/src/Main.kt"]);
    expect(buildEditorArguments(idea, {
      target: "/repo/src/Main.kt",
      projectRoot: "/repo",
      line: 25,
    })).toEqual(["/repo", "--line", "25", "/repo/src/Main.kt"]);
    expect(buildEditorArguments(idea, {
      target: "/repo",
      projectRoot: "/repo",
      isDirectory: true,
    })).toEqual(["/repo"]);
  });
});

describe("line and column validation", () => {
  it("rejects non-positive, fractional, oversized, or orphaned column values", () => {
    for (const invalid of [
      { line: 0 },
      { line: -3 },
      { line: 1.5 },
      { line: Number.NaN },
      { line: Number.POSITIVE_INFINITY },
      { line: 1_000_000_001 },
      { column: 2 },
      { line: 10, column: 0 },
      { line: 10, column: -1 },
      { line: 10, column: 2.2 },
    ]) {
      expect(validateEditorPosition(invalid).ok).toBe(false);
    }
    expect(validateEditorPosition({ line: 1, column: 1 })).toEqual({ ok: true, line: 1, column: 1 });
    expect(parseSourceLocationPosition(":42")).toEqual({ line: 42 });
    expect(parseSourceLocationPosition(":42:7")).toEqual({ line: 42, column: 7 });
    expect(parseSourceLocationPosition("#L12C4")).toEqual({ line: 12, column: 4 });
    expect(parseSourceLocationPosition(":0")).toBeNull();
  });

  it("validates openProjectPath editor requests strictly", () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    expect(parseOpenProjectPathRequest({
      projectId,
      relativePath: "src/app.ts",
      action: "open-in-editor",
      editor: "vscode",
      line: 42,
      column: 5,
    })).toEqual({
      projectId,
      relativePath: "src/app.ts",
      action: "open-in-editor",
      editor: "vscode",
      line: 42,
      column: 5,
    });
    expect(parseOpenProjectPathRequest({
      projectId,
      relativePath: "src/app.ts",
      action: "open-in-editor",
      editor: "notepad",
    })).toBeNull();
    expect(parseOpenProjectPathRequest({
      projectId,
      relativePath: "src/app.ts",
      action: "open-in-editor",
      line: 0,
    })).toBeNull();
    expect(parseOpenProjectPathRequest({
      projectId,
      relativePath: "src/app.ts",
      action: "open-in-editor",
      column: 3,
    })).toBeNull();
    expect(parseOpenProjectPathRequest({
      projectId,
      relativePath: "src/app.ts",
      action: "reveal",
      editor: "vscode",
    })).toBeNull();
    expect(parseGetAvailableEditorsRequest(undefined)).toEqual({});
    expect(parseGetAvailableEditorsRequest({ refresh: true })).toEqual({ refresh: true });
    expect(parseGetAvailableEditorsRequest({ refresh: "yes" })).toBeNull();
    expect(parseGetAvailableEditorsRequest({ extra: 1 })).toBeNull();
  });
});

describe("Windows command shim quoting", () => {
  it("escapes spaces, unicode, and cmd.exe metacharacters without shell mode", () => {
    const invocation = buildWindowsCommandShimInvocation(
      "C:\\Users\\José\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd",
      ["--goto", "C:\\Work\\Proj (2026) & %TEMP%\\café^!|<>file.ts:42:7"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    const cmdLine = invocation.args[4]!;
    expect(cmdLine).toContain("Microsoft^ VS^ Code");
    expect(cmdLine).toContain("café^^^!^|^<^>file.ts:42:7");
    expect(cmdLine).toContain("^%TEMP^%");
    expect(cmdLine).toContain("^&");
    expect(cmdLine).toContain("^(2026^)");
  });

  it("rejects line breaks, NUL and double quotes for .cmd/.bat shims", () => {
    for (const bad of [
      "C:\\repo\\file\r\n&calc.ts",
      "C:\\repo\\file\"&calc.ts",
      "C:\\repo\\file\0.ts",
    ]) {
      expect(() => buildWindowsCommandShimInvocation(
        "C:\\Tools\\code.cmd",
        ["--goto", bad],
        {},
        "win32",
      )).toThrow();
    }
  });

  it("passes .exe binaries directly without cmd.exe", () => {
    const invocation = buildWindowsCommandShimInvocation(
      "C:\\Users\\PC\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe",
      ["C:\\Work\\Proj & café\\app.ts:10"],
      {},
      "win32",
    );
    expect(invocation).toEqual({
      command: "C:\\Users\\PC\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe",
      args: ["C:\\Work\\Proj & café\\app.ts:10"],
    });
  });
});

describe("editor detection", () => {
  it("skips a broken cursor shim on PATH and falls back to the working install", async () => {
    const broken = "/usr/local/bin/cursor";
    const working = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    const fs = makeFakeFs({
      platform: "darwin",
      files: [broken, working],
      entries: { "/Applications": ["Cursor.app"] },
    });
    const probeVersion = vi.fn(async (executable: string) => (
      executable === broken
        ? { exitCode: 1, stdout: "", timedOut: false }
        : { exitCode: 0, stdout: "0.49.0\n", timedOut: false }
    ));
    const resolved = await resolveEditorExecutable(editorById("cursor")!, {
      platform: "darwin",
      env: () => ({ PATH: "/usr/local/bin", HOME: "/Users/dev" }),
      homeDir: () => "/Users/dev",
      ...fs,
      probeVersion,
    });
    expect(resolved).toEqual({ command: working, baseArgs: ["--classic"] });
    expect(probeVersion).toHaveBeenCalledTimes(2);
  });

  it("prefers stable Zed over prerelease Zed on Windows and ignores extensionless shims", async () => {
    const preview = "C:\\Tools\\Zed Preview\\bin\\zed.exe";
    const stable = "C:\\Users\\PC\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe";
    const bashShim = "C:\\Tools\\Zed Preview\\bin\\zed";
    const fs = makeFakeFs({
      platform: "win32",
      files: [bashShim, preview, stable],
    });
    const resolved = await resolveEditorExecutable(editorById("zed")!, {
      platform: "win32",
      env: () => ({
        PATH: "C:\\Tools\\Zed Preview\\bin;C:\\Users\\PC\\AppData\\Local\\Programs\\Zed\\bin",
        PATHEXT: ".EXE;.CMD;.BAT",
        LOCALAPPDATA: "C:\\Users\\PC\\AppData\\Local",
      }),
      homeDir: () => "C:\\Users\\PC",
      ...fs,
    });
    expect(resolved).toEqual({ command: stable, baseArgs: [] });
  });

  it("ignores OpenZFS zed daemon on Linux and selects zeditor or verified Zed", async () => {
    const zfsZed = "/usr/sbin/zed";
    const realZed = "/home/dev/.local/bin/zed";
    const fs = makeFakeFs({
      platform: "linux",
      files: [zfsZed, realZed],
    });
    const probeVersion = vi.fn(async (executable: string) => (
      executable === zfsZed
        ? { exitCode: 1, stdout: "zed: invalid option", timedOut: false }
        : { exitCode: 0, stdout: "Zed 0.180.0", timedOut: false }
    ));
    const resolved = await resolveEditorExecutable(editorById("zed")!, {
      platform: "linux",
      env: () => ({ PATH: "/usr/sbin:/home/dev/.local/bin", HOME: "/home/dev" }),
      homeDir: () => "/home/dev",
      ...fs,
      probeVersion,
    });
    expect(resolved).toEqual({ command: realZed, baseArgs: [] });
  });

  it("finds numbered JetBrains Toolbox scripts and caches detection with TTL and refresh", async () => {
    const toolboxScript = "C:\\Users\\PC\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea1.cmd";
    let installed = true;
    let clock = 1_000;
    const baseFs = makeFakeFs({
      platform: "win32",
      files: [toolboxScript],
      entries: { "C:\\Users\\PC\\AppData\\Local\\JetBrains\\Toolbox\\scripts": ["idea1.cmd"] },
    });
    const statSpy = vi.fn(async (filePath: string) => (installed ? baseFs.stat!(filePath) : null));
    const launcher = new EditorLauncher({
      platform: "win32",
      env: () => ({
        PATH: "",
        PATHEXT: ".EXE;.CMD;.BAT",
        LOCALAPPDATA: "C:\\Users\\PC\\AppData\\Local",
      }),
      homeDir: () => "C:\\Users\\PC",
      ...baseFs,
      stat: statSpy,
      now: () => clock,
      cacheTtlMs: 30_000,
    });

    const first = await launcher.detectAvailableEditors();
    expect(first).toEqual([{ id: "idea", label: "IntelliJ IDEA" }]);
    const callsAfterFirst = statSpy.mock.calls.length;

    const cached = await launcher.detectAvailableEditors();
    expect(cached).toEqual(first);
    expect(statSpy.mock.calls.length).toBe(callsAfterFirst);

    installed = false;
    const refreshed = await launcher.detectAvailableEditors({ refresh: true });
    expect(refreshed).toEqual([]);

    installed = true;
    clock += 31_000;
    const expired = await launcher.detectAvailableEditors();
    expect(expired).toEqual([{ id: "idea", label: "IntelliJ IDEA" }]);
  });
});

describe("editor launch authorization and process hygiene", () => {
  it("refuses files outside the authorized project root, symlinks, and invalid positions", async () => {
    const spawned: EditorSpawnRequest[] = [];
    const fs = makeFakeFs({
      platform: "linux",
      files: ["/usr/bin/code", "/workspace/app/src/index.ts", "/etc/passwd"],
      dirs: ["/workspace/app"],
      symlinks: ["/workspace/app/escape.ts"],
    });
    const launcher = new EditorLauncher({
      platform: "linux",
      env: () => ({
        PATH: "/usr/bin",
        HOME: "/home/dev",
        ELECTRON_RUN_AS_NODE: "1",
        OPENAI_API_KEY: "secret-key",
      }),
      homeDir: () => "/home/dev",
      ...fs,
      spawnProcess: async (request) => { spawned.push(request); },
    });

    await expect(launcher.launchEditor({
      editor: "vscode",
      targetPath: "/etc/passwd",
      authorizedRoot: "/workspace/app",
      line: 1,
    })).rejects.toThrow("outside the authorized project");

    await expect(launcher.launchEditor({
      editor: "vscode",
      targetPath: "/workspace/app/escape.ts",
      authorizedRoot: "/workspace/app",
    })).rejects.toThrow("regular file or folder");

    await expect(launcher.launchEditor({
      editor: "vscode",
      targetPath: "/workspace/app/src/index.ts",
      authorizedRoot: "/workspace/app",
      line: -5,
    })).rejects.toThrow("positive integer");

    expect(spawned).toHaveLength(0);

    await launcher.launchEditor({
      editor: "vscode",
      targetPath: "/workspace/app/src/index.ts",
      authorizedRoot: "/workspace/app",
      line: 42,
      column: 3,
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      command: "/usr/bin/code",
      args: ["--goto", "/workspace/app/src/index.ts:42:3"],
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    expect(spawned[0]!.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(spawned[0]!.env.OPENAI_API_KEY).toBe("secret-key");
  });

  it("launches editors with the user's environment minus runtime and Inertia variables", async () => {
    const toolboxScript = "C:\\Users\\PC\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea1.cmd";
    const spawned: EditorSpawnRequest[] = [];
    const launcher = new EditorLauncher({
      platform: "win32",
      env: () => ({
        PATH: "C:\\Windows\\System32",
        PATHEXT: ".EXE;.CMD;.BAT",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        LOCALAPPDATA: "C:\\Users\\PC\\AppData\\Local",
        JAVA_HOME: "C:\\Java\\jdk-21",
        GOPATH: "C:\\Users\\PC\\go",
        VIRTUAL_ENV: "C:\\repo\\.venv",
        MY_PROJECT_FLAG: "on",
        ELECTRON_RUN_AS_NODE: "1",
        Electron_No_Attach_Console: "1",
        NODE_OPTIONS: "--require hook.js",
        NODE_CHANNEL_FD: "3",
        INERTIA_HOST_MCP_TOKEN: "host-token",
        INERTIA_DATA_DIR: "C:\\Users\\PC\\AppData\\Roaming\\Inertia",
        NoDefaultCurrentDirectoryInExePath: "1",
      }),
      homeDir: () => "C:\\Users\\PC",
      ...makeFakeFs({
        platform: "win32",
        files: [toolboxScript, "C:\\repo\\src\\app.ts"],
        dirs: ["C:\\repo"],
        entries: { "C:\\Users\\PC\\AppData\\Local\\JetBrains\\Toolbox\\scripts": ["idea1.cmd"] },
      }),
      spawnProcess: async (request) => { spawned.push(request); },
    });

    await launcher.launchEditor({ editor: "idea", targetPath: "C:\\repo\\src\\app.ts", authorizedRoot: "C:\\repo", line: 4 });

    expect(spawned).toHaveLength(1);
    const [request] = spawned;
    expect(request).toMatchObject({ shell: false, windowsVerbatimArguments: true });
    expect(request!.env).toMatchObject({
      JAVA_HOME: "C:\\Java\\jdk-21",
      GOPATH: "C:\\Users\\PC\\go",
      VIRTUAL_ENV: "C:\\repo\\.venv",
      MY_PROJECT_FLAG: "on",
    });
    for (const key of ["ELECTRON_RUN_AS_NODE", "Electron_No_Attach_Console", "NODE_OPTIONS", "NODE_CHANNEL_FD", "INERTIA_HOST_MCP_TOKEN", "INERTIA_DATA_DIR"]) {
      expect(request!.env[key]).toBeUndefined();
    }
    expect(request!.env.NoDefaultCurrentDirectoryInExePath).toBe(userWindowsCurrentDirectorySearch());
    expect(request!.args.join(" ")).not.toContain("NoDefaultCurrentDirectoryInExePath");
    expect(request!.args.join(" ")).toContain("idea1.cmd");
  });

  it("falls back to the system file handler when the preferred editor cannot launch", async () => {
    const shell = {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn(),
    };
    const directory = mkdtempSync(join(tmpdir(), "inertia-editor-fallback-"));
    try {
      const file = join(directory, "notes.txt");
      writeFileSync(file, "notes");
      const editorOpen = vi.fn(async () => { throw new Error("Visual Studio Code is not installed."); });
      await expect(openDesktopLink(pathToFileURL(file).href, shell, process.platform, editorOpen)).resolves.toBeUndefined();
      expect(editorOpen).toHaveBeenCalledOnce();
      expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(file);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("forwards line and column from file:// links to the preferred editor hook", async () => {
    const shell = {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn(),
    };
    const editorOpen = vi.fn(async () => true);
    await openDesktopLink("file:///C:/repo/src/app.ts:42:7", shell, "win32", editorOpen);
    expect(editorOpen).toHaveBeenCalledExactlyOnceWith("C:\\repo\\src\\app.ts", { line: 42, column: 7 });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("escapes '=' and rejects tabs or control characters in Windows command shim invocations", () => {
    const escaped = buildWindowsCommandShimInvocation(
      "C:\\Tools\\code.cmd",
      ["C:\\repo\\a=b&calc.txt"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );
    expect(escaped.args.at(-1)).toContain("a^=b^&calc.txt");
    expect(() => buildWindowsCommandShimInvocation(
      "C:\\Tools\\code.cmd",
      ["C:\\repo\\tab\tname.txt"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    )).toThrow();
    expect(() => buildWindowsCommandShimInvocation(
      "C:\\Tools\\code.cmd",
      ["C:\\repo\\bell\x07name.txt"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    )).toThrow();
  });

  it("ignores relative PATH segments when resolving editor executables and validates projectRoot", async () => {
    const resolved = await resolveEditorExecutable(editorById("vscode")!, {
      platform: "linux",
      env: () => ({ PATH: ".:./bin:relative/bin" }),
      homeDir: () => "/home/user",
      ...makeFakeFs({
        platform: "linux",
        files: ["code", "bin/code", "relative/bin/code"],
      }),
    });
    expect(resolved).toBeNull();

    const launcher = new EditorLauncher({
      platform: "linux",
      env: () => ({ PATH: "/usr/bin" }),
      homeDir: () => "/home/user",
      ...makeFakeFs({
        platform: "linux",
        files: ["/usr/bin/code", "/workspace/app/src/index.ts"],
        dirs: ["/workspace/app", "/other"],
      }),
      spawnProcess: async () => undefined,
    });
    await expect(launcher.launchEditor({
      editor: "vscode",
      targetPath: "/workspace/app/src/index.ts",
      authorizedRoot: "/workspace/app",
      projectRoot: "relative/root",
    })).rejects.toThrow("absolute");
    await expect(launcher.launchEditor({
      editor: "vscode",
      targetPath: "/workspace/app/src/index.ts",
      authorizedRoot: "/workspace/app",
      projectRoot: "/other",
    })).rejects.toThrow("outside the project root");
  });
});
