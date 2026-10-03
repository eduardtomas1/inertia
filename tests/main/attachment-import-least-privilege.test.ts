import { constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as Array<{ path: string; flags: number }>);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (typeof args[0] === "string" && typeof args[1] === "number") {
        opened.push({ path: args[0], flags: args[1] });
      }
      return await actual.open(...args);
    },
  };
});

const { AttachmentRegistry } = await import("../../src/main/attachment-registry");
const {
  inProcessAttachmentImportValidationRunner,
} = await import("../../src/main/attachment-import-file");
type Operation = import("../../src/main/attachment-import-file").AttachmentImportFileOperation;

const roots: string[] = [];
afterEach(async () => {
  opened.length = 0;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function registry() {
  const root = await mkdtemp(join(tmpdir(), "inertia-import-privilege-"));
  roots.push(root);
  const operations: Operation[] = [];
  return {
    operations,
    registry: new AttachmentRegistry(join(root, "uploads"), {
      validationRunner: (operation, signal) => {
        operations.push(operation);
        return inProcessAttachmentImportValidationRunner(operation, signal);
      },
    }),
  };
}

function writable(flags: number): boolean {
  return (flags & (constants.O_WRONLY | constants.O_RDWR)) !== 0;
}

describe("attachment import utility privileges", () => {
  it("asks the utility to normalize only images", async () => {
    const { registry: attachments, operations } = await registry();
    const png = await createCanvas(4, 4).encode("png");
    await attachments.import([
      { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("plain text") },
      { name: "archive.tar", mimeType: "", data: Buffer.from("opaque") },
      { name: "pixel.png", mimeType: "image/png", data: png },
    ]);
    expect(operations.map(({ name, normalizeImage }) => ({ name, normalizeImage: normalizeImage ?? false })))
      .toEqual([
        { name: "notes.txt", normalizeImage: false },
        { name: "archive.tar", normalizeImage: false },
        { name: "pixel.png", normalizeImage: true },
      ]);
  });

  it("decodes through a read-only handle and writes the converted image through a separate handle", async () => {
    const { registry: attachments, operations } = await registry();
    const canvas = createCanvas(8193, 1);
    canvas.getContext("2d").fillRect(0, 0, 8193, 1);
    const [image] = await attachments.import([
      { name: "wide.png", mimeType: "image/png", data: await canvas.encode("png") },
    ]);
    expect(image?.mimeType).toBe("image/jpeg");
    const utilityOpens = opened.filter(({ path }) => basename(path) === operations[0]!.fileName).slice(1);
    expect(utilityOpens.map(({ flags }) => writable(flags))).toEqual([false, true, false]);
    expect(utilityOpens[1]!.flags & constants.O_RDWR).toBe(0);
  });

  it("never opens a non-image staged file for writing during validation", async () => {
    const { registry: attachments, operations } = await registry();
    await attachments.import([{ name: "notes.txt", mimeType: "text/plain", data: Buffer.from("plain text") }]);
    const utilityOpens = opened.filter(({ path }) => basename(path) === operations[0]!.fileName).slice(1);
    expect(utilityOpens.length).toBeGreaterThan(0);
    expect(utilityOpens.some(({ flags }) => writable(flags))).toBe(false);
  });
});
