import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openAuthorizedProjectPath } from "../../src/main/project-path-open";

type RealpathCallback = (error: NodeJS.ErrnoException | null, resolved?: string) => void;
const realpathFailure = vi.hoisted(() => ({ native: false, portable: false, calls: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (callback: RealpathCallback) => {
    queueMicrotask(() => callback(Object.assign(new Error("Incorrect function."), { code: "EISDIR" })));
  };
  const realpath = Object.assign(
    (path: string, callback: RealpathCallback) => {
      realpathFailure.calls.push("portable");
      if (realpathFailure.portable) fail(callback);
      else actual.realpath(path, callback);
    },
    {
      native: (path: string, callback: RealpathCallback) => {
        realpathFailure.calls.push("native");
        if (realpathFailure.native) fail(callback);
        else actual.realpath.native(path, callback);
      },
    },
  );
  return { ...actual, default: { ...actual, realpath }, realpath };
});

const roots: string[] = [];
afterEach(() => {
  realpathFailure.native = false;
  realpathFailure.portable = false;
  realpathFailure.calls.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(name: string, directory = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-project-open-")));
  roots.push(root);
  const path = join(root, name);
  if (directory) mkdirSync(path);
  else writeFileSync(path, "Inert test data", { mode: 0o600 });
  const shell = { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() };
  return { root, path, shell };
}

it.each([
  ["win32", "setup.EXE"], ["darwin", "setup.command"], ["linux", "tool.AppImage"], ["linux", "report.docm"],
] as const)("reveals a potential %s launcher named %s", async (platform, name) => {
  const { path, shell } = fixture(name);
  expect(await openAuthorizedProjectPath(path, "open-externally", shell, platform)).toBe("");
  expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it("reveals macOS application bundles while ordinary folders can open", async () => {
  const app = fixture("Example.app", true);
  const folder = fixture("Documents", true);
  await openAuthorizedProjectPath(app.path, "open-externally", app.shell, "darwin");
  await openAuthorizedProjectPath(folder.path, "open-externally", folder.shell, "darwin");
  expect(app.shell.openPath).not.toHaveBeenCalled();
  expect(app.shell.showItemInFolder).toHaveBeenCalledWith(app.path);
  expect(folder.shell.openPath).toHaveBeenCalledWith(folder.path);
});

it.runIf(process.platform !== "win32")("reveals extensionless executable files and replaced symlinks", async () => {
  const { root, path, shell } = fixture("program");
  chmodSync(path, 0o700);
  await openAuthorizedProjectPath(path, "open-externally", shell, "linux");
  const link = join(root, "notes.md");
  symlinkSync(path, link);
  await openAuthorizedProjectPath(link, "open-externally", shell, "linux");
  expect(shell.showItemInFolder).toHaveBeenCalledTimes(2);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it("opens ordinary documents and preserves the explicit reveal action", async () => {
  const { path, shell } = fixture("notes.md");
  await openAuthorizedProjectPath(path, "open-externally", shell);
  expect(shell.openPath).toHaveBeenCalledWith(path);
  shell.openPath.mockClear();
  await openAuthorizedProjectPath(path, "reveal", shell);
  expect(shell.openPath).not.toHaveBeenCalled();
  expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
});

it("does not open a file when inspection fails or expose its absolute path", async () => {
  const { path, shell } = fixture("missing.md");
  rmSync(path);
  await expect(openAuthorizedProjectPath(path, "open-externally", shell))
    .rejects.toThrow(/^The project file could not be inspected\.$/u);
  expect(shell.openPath).not.toHaveBeenCalled();
});

const LINK_REVEALED = [
  ".pyw", ".pyz", ".pyzw", ".pyc", ".pyo", ".rbw", ".rb", ".jnlp", ".library-ms", ".searchConnector-ms",
  ".search-ms", ".settingcontent-ms", ".rdp", ".theme", ".themepack", ".deskthemepack", ".diagcab", ".msu",
  ".appinstaller", ".msixbundle", ".appxbundle", ".wsc", ".sct", ".ps1xml", ".psc1", ".inf", ".ahk", ".xbap",
  ".doc", ".xls", ".ppt", ".pps", ".dot", ".xlt", ".xla", ".pot", ".ppa",
  ".py", ".js", ".vbs", ".ps1", ".bat", ".cmd", ".exe", ".lnk", ".url", ".scr", ".hta", ".msi", ".jar",
  ".reg", ".cpl", ".msc", ".application",
];

it.each(LINK_REVEALED.flatMap((extension) => (["win32", "darwin", "linux"] as const).map((platform) => [platform, extension] as const)))(
  "reveals a %s %s file for both link clicks and the explicit open action", async (platform, extension) => {
    const { path, shell } = fixture(`payload${extension}`);
    await openAuthorizedProjectPath(path, "open-link", shell, platform);
    await openAuthorizedProjectPath(path, "open-externally", shell, platform);
    expect(shell.showItemInFolder.mock.calls).toEqual([[path], [path]]);
    expect(shell.openPath).not.toHaveBeenCalled();
  },
);

it.each(["program", "source.ts", "page.html", "image.svg", "archive.zip", "notes.md.exe", "report.txt.pyw"])(
  "reveals %s for a link click because only inert document types may open", async (name) => {
    const { path, shell } = fixture(name);
    await openAuthorizedProjectPath(path, "open-link", shell, "win32");
    expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
    expect(shell.openPath).not.toHaveBeenCalled();
  },
);

it("reveals folders for a link click while the explicit open action can still open them", async () => {
  const { path, shell } = fixture("Documents", true);
  await openAuthorizedProjectPath(path, "open-link", shell);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
  expect(shell.openPath).not.toHaveBeenCalled();
  await openAuthorizedProjectPath(path, "open-externally", shell);
  expect(shell.openPath).toHaveBeenCalledWith(path);
});

it.each([
  "notes.md", "README.markdown", "build.log", "plain.txt", "data.json", "config.yaml", "config.yml", "Cargo.toml",
  "photo.PNG", "photo.jpeg", "anim.gif", "photo.webp", "icon.ico", "paper.pdf", "song.mp3", "clip.mp4",
])("opens the inert document %s from a link click", async (name) => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const { path, shell } = fixture(name);
    expect(await openAuthorizedProjectPath(path, "open-link", shell, platform)).toBe("");
    expect(shell.openPath).toHaveBeenCalledWith(path);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  }
});

it.each(["letter.docx", "sheet.xlsx", "deck.pptx", "text.odt", "calc.ods", "slides.odp", "table.csv", "table.TSV"])(
  "reveals the active-content document %s for a link click while the explicit open action still opens it", async (name) => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const { path, shell } = fixture(name);
      await openAuthorizedProjectPath(path, "open-link", shell, platform);
      expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
      expect(shell.openPath).not.toHaveBeenCalled();
      await openAuthorizedProjectPath(path, "open-externally", shell, platform);
      expect(shell.openPath).toHaveBeenCalledWith(path);
    }
  },
);

it("falls back to the portable resolver when the native resolver cannot handle the volume", async () => {
  realpathFailure.native = true;
  const { path, shell } = fixture("notes.md");
  await openAuthorizedProjectPath(path, "open-link", shell);
  await openAuthorizedProjectPath(path, "open-externally", shell);
  expect(shell.openPath.mock.calls).toEqual([[path], [path]]);
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  expect(realpathFailure.calls).toEqual(["native", "portable", "native", "portable"]);
});

it("reveals instead of opening when neither resolver can resolve the file", async () => {
  realpathFailure.native = true;
  realpathFailure.portable = true;
  const { path, shell } = fixture("notes.md");
  expect(await openAuthorizedProjectPath(path, "open-link", shell)).toBe("");
  expect(await openAuthorizedProjectPath(path, "open-externally", shell)).toBe("");
  expect(shell.showItemInFolder.mock.calls).toEqual([[path], [path]]);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it.runIf(process.platform !== "win32")("reveals Windows stream, trailing-dot and short-name spellings on win32", async () => {
  for (const name of ["notes.txt:$DATA", "notes~1.txt", "notes.txt.", "notes.txt "]) {
    const { path, shell } = fixture(name);
    await openAuthorizedProjectPath(path, "open-link", shell, "win32");
    await openAuthorizedProjectPath(path, "open-externally", shell, "win32");
    expect(shell.showItemInFolder.mock.calls).toEqual([[path], [path]]);
    expect(shell.openPath).not.toHaveBeenCalled();
  }
});

it.runIf(process.platform === "win32")("reveals an NTFS index-allocation alias of a project folder", async () => {
  const { root, shell } = fixture("coolrepo", true);
  for (const name of ["notes.txt", "x.pyw"]) {
    writeFileSync(join(root, "coolrepo", name), "Inert test data");
    const alias = join(root, "coolrepo::$INDEX_ALLOCATION", name);
    await openAuthorizedProjectPath(alias, "open-link", shell, "win32");
    await openAuthorizedProjectPath(alias, "open-externally", shell, "win32");
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(alias);
  }
  expect(shell.showItemInFolder).toHaveBeenCalledTimes(4);
  expect(shell.openPath).not.toHaveBeenCalled();
});

function shortPath(path: string): string {
  return spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${path}") do @echo %~sI`], {
    windowsVerbatimArguments: true, encoding: "utf8",
  }).stdout.trim();
}

it.runIf(process.platform === "win32")("reveals 8.3 short-name aliases, including truncated launcher extensions", async (ctx) => {
  const { root, shell } = fixture("Coolrepository", true);
  const targets = ["remote.library-ms", "notes-with-long-name.txt"].map((name) => {
    const path = join(root, "Coolrepository", name);
    writeFileSync(path, "Inert test data");
    return shortPath(path);
  });
  if (targets.some((path) => !/~\d/u.test(path))) ctx.skip("8.3 short names are disabled on this volume");
  for (const path of targets) {
    await openAuthorizedProjectPath(path, "open-link", shell, "win32");
    await openAuthorizedProjectPath(path, "open-externally", shell, "win32");
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(path);
  }
  expect(shell.showItemInFolder).toHaveBeenCalledTimes(4);
  expect(shell.openPath).not.toHaveBeenCalled();
});
