import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSnapshotPreferences, writeSnapshotPreferences } from "../../src/main/snapshot-preferences";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "inertia-snapshot-settings-")); directories.push(path); return path; }
it("persists shortcut preferences privately and replaces them without leaving temporary files", async () => {
  const root = await directory();
  expect(await readSnapshotPreferences(root)).toBeNull();
  await writeSnapshotPreferences(root, { enabled: true, shortcut: "both-shift" });
  expect(await readSnapshotPreferences(root)).toEqual({ enabled: true, shortcut: "both-shift" });
  await writeSnapshotPreferences(root, { enabled: false, shortcut: "accelerator" });
  expect(await readSnapshotPreferences(root)).toEqual({ enabled: false, shortcut: "accelerator" });
  expect(await readdir(root)).toEqual(["snapshot-preferences.json"]);
  if (process.platform !== "win32") expect((await lstat(join(root, "snapshot-preferences.json"))).mode & 0o777).toBe(0o600);
});
it.skipIf(process.platform === "win32")("does not follow a preferences symlink", async () => {
  const root = await directory(); const outside = join(root, "outside.json");
  await writeFile(outside, "untouched"); await symlink(outside, join(root, "snapshot-preferences.json"));
  expect(await readSnapshotPreferences(root)).toBeNull();
  await expect(writeSnapshotPreferences(root, { enabled: true, shortcut: "both-shift" })).rejects.toThrow("unavailable");
  expect(await readFile(outside, "utf8")).toBe("untouched");
});
