import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listWorkspaceEntries,
  readWorkspaceTextFile,
  searchWorkspaceEntries,
} from "../../src/server/workspace";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-workspace-tree-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace file hierarchy", () => {
  it("lists one folder at a time with stable directory-first natural sorting", async () => {
    const root = await temporaryDirectory();
    await Promise.all([
      mkdir(join(root, "Folder10")),
      mkdir(join(root, "Folder2")),
      mkdir(join(root, "src", "components"), { recursive: true }),
      mkdir(join(root, ".hidden")),
    ]);
    await Promise.all([
      writeFile(join(root, "file10.ts"), "ten"),
      writeFile(join(root, "file2.ts"), "two"),
      writeFile(join(root, "src", "index.ts"), "index"),
      writeFile(join(root, "src", "components", "Button.tsx"), "button"),
      writeFile(join(root, ".hidden", "secret.ts"), "hidden"),
    ]);

    const rootPage = await listWorkspaceEntries(root);
    expect(rootPage.directory).toBe("");
    expect(rootPage.entries.map(({ path, kind }) => [path, kind])).toEqual([
      ["Folder2", "directory"],
      ["Folder10", "directory"],
      ["src", "directory"],
      ["file2.ts", "file"],
      ["file10.ts", "file"],
    ]);
    expect(rootPage.entries.some(({ path }) => path.includes("Button.tsx"))).toBe(false);
    expect(rootPage.entries.some(({ path }) => path.startsWith(".hidden"))).toBe(false);

    const nestedPage = await listWorkspaceEntries(root, "src");
    expect(nestedPage.directory).toBe("src");
    expect(nestedPage.entries.map(({ path, kind }) => [path, kind])).toEqual([
      ["src/components", "directory"],
      ["src/index.ts", "file"],
    ]);
    await expect(readWorkspaceTextFile(root, "src/components/Button.tsx"))
      .resolves.toMatchObject({ path: "src/components/Button.tsx", content: "button" });
  });

  it("bounds large directory pages and recursive search independently", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "deep", "one", "two"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "root-a.ts"), "a"),
      writeFile(join(root, "root-b.ts"), "b"),
      writeFile(join(root, "root-c.ts"), "c"),
      writeFile(join(root, "deep", "one", "two", "Needle.ts"), "needle"),
    ]);

    const page = await listWorkspaceEntries(root, "", { maxEntries: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.truncated).toBe(true);

    const search = await searchWorkspaceEntries(root, "needle");
    expect(search.entries.map(({ path }) => path)).toEqual([
      "deep/one/two/Needle.ts",
    ]);
    expect(search.truncated).toBe(false);
  });

  it("rejects traversal, portable absolute paths, and symlink access", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(join(root, "safe"));
    await writeFile(join(root, "safe", "inside.ts"), "inside");
    await writeFile(join(outside, "secret.ts"), "secret");
    await symlink(
      outside,
      join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    for (const path of [
      "../outside",
      "safe/../../outside",
      "safe\\..\\outside",
      "/etc",
      "\\\\server\\share",
      "C:\\Windows",
      "C:Windows",
    ]) {
      await expect(listWorkspaceEntries(root, path))
        .rejects.toMatchObject({ code: "invalid-input" });
    }
    await expect(listWorkspaceEntries(root, "escape"))
      .rejects.toMatchObject({ code: "unsafe-link" });
    await expect(readWorkspaceTextFile(root, "escape/secret.ts"))
      .rejects.toMatchObject({ code: "unsafe-link" });
  });
});
