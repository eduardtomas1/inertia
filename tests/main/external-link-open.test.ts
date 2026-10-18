import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { openDesktopLink } from "../../src/main/external-link-open";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(name = "Workflow with spaces.json") {
  const root = mkdtempSync(join(tmpdir(), "inertia-file-link-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, "Inert fixture", { mode: 0o600 });
  const shell = { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) };
  return { root, path, shell };
}

it("opens an ordinary file outside any project using the OS document handler", async () => {
  const { path, shell } = fixture();
  await openDesktopLink(pathToFileURL(path).href + "#L12", shell);
  expect(shell.openPath).toHaveBeenCalledWith(path);
  expect(shell.openExternal).not.toHaveBeenCalled();
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
});

it("opens source links with line, column, and range suffixes", async () => {
  const { path, shell } = fixture("source.ts");
  for (const suffix of [":42", ":42:7", ":42-45", ":42:7-45:8"]) {
    await openDesktopLink(pathToFileURL(path).href + suffix, shell);
  }
  expect(shell.openPath.mock.calls).toEqual([[path], [path], [path], [path]]);
});

it.runIf(process.platform !== "win32")("prefers literal filenames and never falls back for encoded colons", async () => {
  const { path, shell } = fixture("source.ts");
  const literal = `${path}:42`;
  writeFileSync(literal, "Literal filename", { mode: 0o600 });
  await openDesktopLink(pathToFileURL(path).href + ":42", shell);
  expect(shell.openPath).toHaveBeenLastCalledWith(literal);
  rmSync(literal);
  await expect(openDesktopLink(pathToFileURL(path).href + "%3A42", shell)).rejects.toThrow("could not be opened");
  expect(shell.openPath).toHaveBeenCalledTimes(1);
});

it.each(["launcher.desktop", "setup.exe", "script.command"])("reveals %s without launching it", async (name) => {
  const { path, shell } = fixture(name);
  await openDesktopLink(pathToFileURL(path).href, shell);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(path);
  expect(shell.openPath).not.toHaveBeenCalled();
  expect(shell.openExternal).not.toHaveBeenCalled();
});

it.runIf(process.platform !== "win32")("reveals executable files and symlinks", async () => {
  const { root, path, shell } = fixture("program");
  chmodSync(path, 0o700);
  const link = join(root, "notes.md");
  symlinkSync(path, link);
  await openDesktopLink(pathToFileURL(path).href, shell);
  await openDesktopLink(pathToFileURL(link).href, shell);
  expect(shell.showItemInFolder.mock.calls).toEqual([[path], [link]]);
  expect(shell.openPath).not.toHaveBeenCalled();
});

it("reports missing files and handler errors without exposing paths", async () => {
  const { path, shell } = fixture();
  shell.openPath.mockResolvedValueOnce(`Cannot open ${path}`);
  await expect(openDesktopLink(pathToFileURL(path).href, shell)).rejects.toThrow(/^The local file could not be opened\.$/u);
  rmSync(path);
  shell.openPath.mockClear();
  await expect(openDesktopLink(pathToFileURL(path).href, shell)).rejects.toThrow(/^The local file could not be opened\.$/u);
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
