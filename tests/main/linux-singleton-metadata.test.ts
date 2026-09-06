import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";

import { readLinuxSingletonManifest } from "../../src/main/linux-singleton-metadata";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-singleton-entry-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("bounded singleton archive entries", () => {
  it("reads a valid packed manifest through the raw Node filesystem", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    const archive = join(root, "app.asar");
    const manifest = '{"name":"inertia","version":"1.2.3"}';
    await mkdir(source);
    await writeFile(join(source, "package.json"), manifest);
    await createPackage(source, archive);

    expect(readLinuxSingletonManifest(archive, 65_536)).toBe(manifest);
  });

  it("rejects an oversized declared header before allocating it", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "app.asar");
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(1_073_741_824, 4);
    prefix.writeUInt32LE(1_073_741_820, 8);
    prefix.writeUInt32LE(1_073_741_816, 12);
    await writeFile(archive, prefix);

    expect(() => readLinuxSingletonManifest(archive, 65_536))
      .toThrow("Invalid bounded singleton archive header.");
  });

  it.each([
    { size: 1, offset: "0", link: "other.json" },
    { size: 1, offset: "0", unpacked: true },
    { size: 1, offset: "0", files: {} },
    { size: -1, offset: "0" },
    { size: 65_537, offset: "0" },
    { size: 1, offset: "-1" },
    { size: 1, offset: "9007199254740992" },
    { size: 1, offset: "20" },
  ])("rejects unsafe manifest metadata %j", async (entry) => {
    const root = await temporaryRoot();
    const archive = join(root, "app.asar");
    const json = Buffer.from(JSON.stringify({ files: { "package.json": entry } }));
    const headerSize = 8 + Math.ceil(json.length / 4) * 4;
    const content = Buffer.alloc(8 + headerSize + 1);
    content.writeUInt32LE(4, 0);
    content.writeUInt32LE(headerSize, 4);
    content.writeUInt32LE(headerSize - 4, 8);
    content.writeUInt32LE(json.length, 12);
    json.copy(content, 16);
    await writeFile(archive, content);
    expect(() => readLinuxSingletonManifest(archive, 65_536)).toThrow(/singleton manifest/u);
  });
});
