import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { openAuthorizedDesktopLink, type EditorRuntimeBridge } from "../../src/main/editor-ipc";
import type { EditorLauncher } from "../../src/main/editor-launcher";
import { openDesktopLink } from "../../src/main/external-link-open";

const allowAllLocalFiles = async (path: string): Promise<string> => path;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(name = "Workflow with spaces.json") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-file-link-")));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, "Inert fixture", { mode: 0o600 });
  const shell = { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) };
  return { root, path, shell };
}

it("opens an authorized local file using the OS document handler", async () => {
  const { path, shell } = fixture();
  await openDesktopLink(pathToFileURL(path).href + "#L12", shell, process.platform, undefined, allowAllLocalFiles);
  expect(shell.openPath).toHaveBeenCalledWith(path);
  expect(shell.openExternal).not.toHaveBeenCalled();
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
});

it("opens inert document links with line, column, and range suffixes", async () => {
  const { path, shell } = fixture("notes.md");
  for (const suffix of [":42", ":42:7", ":42-45", ":42:7-45:8"]) {
    await openDesktopLink(pathToFileURL(path).href + suffix, shell, process.platform, undefined, allowAllLocalFiles);
  }
  expect(shell.openPath.mock.calls).toEqual([[path], [path], [path], [path]]);
});

it("reveals source files from links instead of handing them to an interpreter", async () => {
  const { path, shell } = fixture("source.ts");
  await openDesktopLink(pathToFileURL(path).href + ":42", shell, process.platform, undefined, allowAllLocalFiles);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it.runIf(process.platform !== "win32")("prefers literal filenames and never falls back for encoded colons", async () => {
  const { path, shell } = fixture("source.txt");
  const literal = `${path}:42`;
  writeFileSync(literal, "Literal filename", { mode: 0o600 });
  await openDesktopLink(pathToFileURL(path).href + ":42", shell, process.platform, undefined, allowAllLocalFiles);
  expect(shell.showItemInFolder).toHaveBeenLastCalledWith(literal);
  expect(shell.openPath).not.toHaveBeenCalled();
  rmSync(literal);
  await expect(openDesktopLink(pathToFileURL(path).href + "%3A42", shell, process.platform, undefined, allowAllLocalFiles)).rejects.toThrow("could not be opened");
  expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it.each([
  "launcher.desktop", "setup.exe", "script.command", "x.pyw", "x.pyz", "x.pyzw", "x.pyc", "x.pyo", "x.rbw", "x.rb",
  "x.jnlp", "x.library-ms", "x.searchConnector-ms", "x.search-ms", "x.settingcontent-ms", "x.rdp", "x.theme",
  "x.themepack", "x.deskthemepack", "x.diagcab", "x.msu", "x.appinstaller", "x.msixbundle", "x.appxbundle",
  "x.wsc", "x.sct", "x.ps1xml", "x.psc1", "x.inf", "x.ahk", "x.xbap", "x.doc", "x.xls", "x.ppt", "x.pps",
  "x.dot", "x.xlt", "x.xla", "x.pot", "x.ppa", "x.svg", "x.html", "program", "x.docx", "x.xlsx", "x.pptx",
  "x.odt", "x.ods", "x.odp", "x.csv", "x.tsv",
])("reveals %s without launching it", async (name) => {
  const { path, shell } = fixture(name);
  await openDesktopLink(pathToFileURL(path).href, shell, process.platform, undefined, allowAllLocalFiles);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
  expect(shell.openPath).not.toHaveBeenCalled();
  expect(shell.openExternal).not.toHaveBeenCalled();
});

it.runIf(process.platform !== "win32")("reveals executable files and symlinks", async () => {
  const { root, path, shell } = fixture("program");
  chmodSync(path, 0o700);
  const link = join(root, "notes.md");
  symlinkSync(path, link);
  await openDesktopLink(pathToFileURL(path).href, shell, process.platform, undefined, allowAllLocalFiles);
  await openDesktopLink(pathToFileURL(link).href, shell, process.platform, undefined, allowAllLocalFiles);
  expect(shell.showItemInFolder.mock.calls).toEqual([[path], [link]]);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it("reports missing files and handler errors without exposing paths", async () => {
  const { path, shell } = fixture();
  shell.openPath.mockResolvedValueOnce(`Cannot open ${path}`);
  await expect(openDesktopLink(pathToFileURL(path).href, shell, process.platform, undefined, allowAllLocalFiles)).rejects.toThrow(/^The local file could not be opened\.$/u);
  rmSync(path);
  shell.openPath.mockClear();
  await expect(openDesktopLink(pathToFileURL(path).href, shell, process.platform, undefined, allowAllLocalFiles)).rejects.toThrow(/^The local file could not be opened\.$/u);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it.each(["javascript:alert(1)", "data:text/html,x", "inertia://runtime/command", "file:///tmp/a%00", "file:///tmp/a?run=1", "file://user@host/share"])(
  "rejects invalid or executable protocol %s", async (href) => {
    const { shell } = fixture();
    await expect(openDesktopLink(href, shell)).rejects.toThrow();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  },
);

it.each(["file://files.attacker.example/share/x", "file://server/share/notes.md", "file://localhost./share/x"])(
  "refuses %s before touching the file system on Windows", async (href) => {
    const { shell } = fixture();
    await expect(openDesktopLink(href, shell, "win32")).rejects.toThrow(/^Invalid local file link\.$/u);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  },
);

it("hands HTTP and HTTPS links to the system browser", async () => {
  const { shell } = fixture();
  await openDesktopLink("https://example.test/docs", shell);
  await openDesktopLink("http://localhost:3000", shell);
  await openDesktopLink("http://example.test/plain", shell);
  expect(shell.openExternal.mock.calls).toEqual([
    ["https://example.test/docs"], ["http://localhost:3000/"], ["http://example.test/plain"],
  ]);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it.each([
  "https://user:secret@example.test/", "http://user@example.test/", "ftp://example.test/file",
  `https://example.test/${"a".repeat(4_096)}`, "", "not a url",
])("refuses web link %s", async (href) => {
  const { shell } = fixture();
  await expect(openDesktopLink(href, shell)).rejects.toThrow();
  expect(shell.openExternal).not.toHaveBeenCalled();
});

it("reveals non-inert link targets on the host platform and never opens them", async () => {
  for (const name of ["x.pyw", "x.library-ms", "x.rdp", "x.theme", "x.doc", "x.xls", "x.ppt"]) {
    const { path, shell } = fixture(name);
    await openDesktopLink(pathToFileURL(path).href, shell, process.platform, undefined, allowAllLocalFiles);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
    expect(shell.openPath).not.toHaveBeenCalled();
  }
});

it("reveals folders reached by a link", async () => {
  const { root, shell } = fixture();
  const folder = join(root, "Documents");
  mkdirSync(folder);
  await openDesktopLink(pathToFileURL(folder).href, shell, process.platform, undefined, allowAllLocalFiles);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(folder);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it.each(["notes.txt", "paper.pdf", "photo.png", "data.json", "clip.mp4"])("still opens the inert document %s", async (name) => {
  const { path, shell } = fixture(name);
  await openDesktopLink(pathToFileURL(path).href, shell, process.platform, undefined, allowAllLocalFiles);
  expect(shell.openPath).toHaveBeenCalledWith(path);
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
});

it.each([
  "file:///C:/Users/me/coolrepo::$INDEX_ALLOCATION/x.pyw",
  "file:///C:/Users/me/coolrepo::$INDEX_ALLOCATION/notes.txt",
  "file:///C:/Users/me/coolrepo/notes.txt::$DATA",
  "file:///C:/Users/me/coolrepo/notes.txt:hidden",
  "file:///C:/Users/me/coolrepo%3A%3A%24INDEX_ALLOCATION/x.pyw",
])("rejects the Windows stream link %s before touching the file system", async (href) => {
  const { shell } = fixture();
  await expect(openDesktopLink(href, shell, "win32", undefined, allowAllLocalFiles)).rejects.toThrow(/^The local file could not be opened\.$/u);
  expect(shell.openPath).not.toHaveBeenCalled();
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  expect(shell.openExternal).not.toHaveBeenCalled();
});

it.runIf(process.platform === "win32")("rejects a real NTFS index-allocation alias", async () => {
  const { root, shell } = fixture();
  const repo = join(root, "Coolrepository");
  mkdirSync(repo);
  writeFileSync(join(repo, "x.pyw"), "Inert fixture");
  const alias = join(root, "Coolrepository::$INDEX_ALLOCATION", "x.pyw");
  await expect(openDesktopLink(pathToFileURL(alias).href, shell, "win32", undefined, allowAllLocalFiles)).rejects.toThrow("could not be opened");
  expect(shell.openPath).not.toHaveBeenCalled();
});

it.runIf(process.platform === "win32")("reveals an 8.3 short-name alias", async (ctx) => {
  const { root, shell } = fixture();
  const repo = join(root, "Coolrepository");
  mkdirSync(repo);
  writeFileSync(join(repo, "remote.library-ms"), "Inert fixture");
  const short = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${join(repo, "remote.library-ms")}") do @echo %~sI`], {
    windowsVerbatimArguments: true, encoding: "utf8",
  }).stdout.trim();
  if (!/~\d/u.test(short)) ctx.skip("8.3 short names are disabled on this volume");
  await openDesktopLink(pathToFileURL(short).href, shell, "win32", undefined, allowAllLocalFiles);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(short);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it("fails closed on file:// links when authorization is omitted, denied, or outside the conversation project", async () => {
  const { root, path, shell } = fixture("outside.txt");
  const launcher = {
    detectAvailableEditors: vi.fn(async () => []),
    launchEditor: vi.fn(async () => undefined),
  } as unknown as EditorLauncher;
  const runtime: EditorRuntimeBridge = {
    editorContext: vi.fn(async () => ({ preferredEditor: "system" as const })),
  };

  await expect(openDesktopLink(pathToFileURL(path).href, shell)).rejects.toThrow(/^The local file could not be opened\.$/u);
  await expect(openDesktopLink(pathToFileURL(path).href, shell, process.platform, undefined, async () => null))
    .rejects.toThrow(/^The local file could not be opened\.$/u);
  await expect(openAuthorizedDesktopLink(pathToFileURL(path).href, shell, launcher, runtime, "conv-a"))
    .rejects.toThrow(/^The local file could not be opened\.$/u);
  await expect(openAuthorizedDesktopLink(pathToFileURL(path).href, shell, launcher, null, "conv-a"))
    .rejects.toThrow(/^The local file could not be opened\.$/u);
  expect(runtime.editorContext).toHaveBeenCalledWith(path, "conv-a");
  expect(shell.openPath).not.toHaveBeenCalled();
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  expect(launcher.launchEditor).not.toHaveBeenCalled();

  const authorizedRuntime: EditorRuntimeBridge = {
    editorContext: vi.fn(async () => ({
      preferredEditor: "system" as const,
      authorizedPath: path,
      projectRoot: root,
    })),
  };
  await openAuthorizedDesktopLink(pathToFileURL(path).href, shell, launcher, authorizedRuntime, "conv-a");
  expect(shell.openPath).toHaveBeenCalledWith(path);
  expect(authorizedRuntime.editorContext).toHaveBeenCalledTimes(1);

  shell.openPath.mockClear();
  const editorRuntime: EditorRuntimeBridge = {
    editorContext: vi.fn(async () => ({
      preferredEditor: "vscode" as const,
      authorizedPath: path,
      projectRoot: root,
    })),
  };
  await openAuthorizedDesktopLink(pathToFileURL(path).href + ":12:4", shell, launcher, editorRuntime, "conv-a");
  expect(launcher.launchEditor).toHaveBeenCalledWith({
    editor: "vscode",
    targetPath: path,
    authorizedRoot: root,
    projectRoot: root,
    line: 12,
    column: 4,
  });
  expect(shell.openPath).not.toHaveBeenCalled();
  expect(editorRuntime.editorContext).toHaveBeenCalledTimes(1);
});
