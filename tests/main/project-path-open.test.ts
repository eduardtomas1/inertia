import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openAuthorizedProjectPath } from "../../src/main/project-path-open";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(name: string, directory = false) {
  const root = mkdtempSync(join(tmpdir(), "inertia-project-open-"));
  roots.push(root);
  const path = join(root, name);
  if (directory) mkdirSync(path);
  else writeFileSync(path, "Inert test data", { mode: 0o600 });
  const shell = { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() };
  return { root, path, shell };
}

it.each([
  ["win32", "setup.EXE"], ["win32", "instructions.js"], ["win32", "shortcut.lnk"],
  ["darwin", "setup.command"], ["darwin", "setup.pkg"],
  ["linux", "launcher.desktop"], ["linux", "tool.AppImage"],
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
