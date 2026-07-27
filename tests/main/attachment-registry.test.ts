import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AttachmentRegistry,
  type AttachmentRegistryLimits,
} from "../../src/main/attachment-registry";

const directories: string[] = [];
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const alternatePng = Buffer.concat([png, Buffer.from([0x01])]);

async function registry(limits?: AttachmentRegistryLimits): Promise<{
  directory: string;
  registry: AttachmentRegistry;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-attachment-registry-"));
  directories.push(directory);
  return {
    directory,
    registry: new AttachmentRegistry(directory, limits),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("main-owned attachment registry", () => {
  it("materializes an opaque capability and revalidates its exact bytes", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "preview.png",
      mimeType: "image/png",
      data: png,
    }]);

    expect(imported).toMatchObject({
      name: "preview.png",
      mimeType: "image/png",
      size: png.length,
    });
    expect(imported?.id).toMatch(/^[0-9a-f-]{36}$/u);
    const resolved = await attachments.resolve(imported!.id);
    expect(resolved).toMatchObject({
      id: imported!.id,
      name: imported!.name,
      mimeType: imported!.mimeType,
      size: imported!.size,
    });
    expect(resolved?.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readFile(resolved!.path)).toEqual(png);
  });

  it("rejects content or metadata that changed after privileged import", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "preview.png",
      mimeType: "image/png",
      data: png,
    }]);
    await writeFile(imported!.path, Buffer.from("tampered", "utf8"));

    await expect(attachments.resolve(imported!.id)).rejects.toThrow(
      /changed|metadata|content/u,
    );
  });

  it("releases unsent capabilities and their private copies", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "preview.png",
      mimeType: "image/png",
      data: png,
    }]);

    await attachments.release(imported!.id);
    await expect(attachments.resolve(imported!.id)).resolves.toBeNull();
    await expect(readFile(imported!.path)).rejects.toThrow();
  });

  it("serializes concurrent imports so they cannot race past the session cap", async () => {
    const { directory, registry: attachments } = await registry({
      maxRecords: 1,
      maxBytes: png.length + alternatePng.length,
    });
    const results = await Promise.allSettled([
      attachments.import([{
        name: "first.png",
        mimeType: "image/png",
        data: png,
      }]),
      attachments.import([{
        name: "second.png",
        mimeType: "image/png",
        data: alternatePng,
      }]),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("reuses record and byte capacity after an attachment is released", async () => {
    const { registry: attachments } = await registry({
      maxRecords: 1,
      maxBytes: alternatePng.length,
    });
    const [first] = await attachments.import([{
      name: "first.png",
      mimeType: "image/png",
      data: alternatePng,
    }]);

    await attachments.release(first!.id);
    await expect(attachments.import([{
      name: "second.png",
      mimeType: "image/png",
      data: alternatePng,
    }])).resolves.toHaveLength(1);
  });

  it("rejects an over-cap batch before creating records or files", async () => {
    const { directory, registry: attachments } = await registry({
      maxRecords: 8,
      maxBytes: png.length,
    });

    await expect(attachments.import([
      {
        name: "first.png",
        mimeType: "image/png",
        data: png,
      },
      {
        name: "second.png",
        mimeType: "image/png",
        data: alternatePng,
      },
    ])).rejects.toThrow(/storage is full/u);
    await expect(readdir(directory)).resolves.toEqual([]);

    await expect(attachments.import([{
      name: "fits.png",
      mimeType: "image/png",
      data: png,
    }])).resolves.toHaveLength(1);
  });
});
