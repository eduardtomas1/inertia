// @inertia-test-suite portable
import * as fs from "node:fs/promises";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudePrompt } from "../../src/server/provider/claude-prompt";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../../src/shared/attachments";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

const roots: string[] = [];
async function imagePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inertia-claude-image-"));
  roots.push(root);
  return join(root, "retained.png");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude bounded image prompt preparation", () => {
  it("preserves image order, bytes, and the user prompt", async () => {
    const path = await imagePath();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(path, bytes);
    expect((await claudePrompt("Describe", [path])).message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } },
      { type: "text", text: "Describe" },
    ]);
  });

  it("rejects a file grown beyond the retained bound before allocating its bytes", async () => {
    const path = await imagePath();
    await writeFile(path, "retained bytes");
    await truncate(path, MAX_CHAT_ATTACHMENT_BYTES + 1);
    await expect(claudePrompt("Describe", [path]).then(() => undefined))
      .rejects.toThrow("10 MB safety limit");
  });

  it("keeps the aggregate image-byte limit", async () => {
    const path = await imagePath();
    await writeFile(path, "retained bytes");
    await truncate(path, MAX_CHAT_ATTACHMENT_BYTES);
    await expect(claudePrompt("Describe", [path, path, path]).then(() => undefined))
      .rejects.toThrow("20 MB safety limit");
  });

  it.skipIf(process.platform === "win32")("refuses a replaced image symlink", async () => {
    const path = await imagePath();
    const outside = await imagePath();
    await writeFile(outside, "unrelated bytes");
    await symlink(outside, path);
    await expect(claudePrompt("Describe", [path])).rejects.toThrow("not a regular file");
  });

  it("honors cancellation before opening an image", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(claudePrompt("Describe", ["must-not-open.png"], controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("closes an image and stops the batch when preparation is cancelled", async () => {
    const path = await imagePath();
    await writeFile(path, "retained bytes");
    const controller = new AbortController();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const close = vi.fn<() => Promise<void>>();
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      const originalClose = handle.close.bind(handle);
      close.mockImplementation(originalClose);
      handle.close = close;
      controller.abort();
      return handle;
    });
    await expect(claudePrompt("Describe", [path, path], controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce();
    expect(fs.open).toHaveBeenCalledOnce();
  });
});
