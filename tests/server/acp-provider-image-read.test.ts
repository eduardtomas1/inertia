// @inertia-test-suite portable
import * as fs from "node:fs/promises";
import { mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../../src/shared/attachments";
import { geminiPrompt } from "../../src/server/provider/gemini-acp-session";
import { kimiPrompt } from "../../src/server/provider/kimi-acp-session";
import { cursorPrompt } from "../../src/server/provider/cursor-acp-harness";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

const initialized = {
  protocolVersion: 1,
  agentCapabilities: { promptCapabilities: { image: true } },
};
const roots: string[] = [];
async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inertia-acp-image-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each([
  ["Gemini", geminiPrompt],
  ["Kimi", kimiPrompt],
  ["Cursor", cursorPrompt],
] as const)("%s final provider image read", (_provider, prompt) => {
  it("preserves supported image bytes and refuses unnegotiated media", async () => {
    const root = await fixtureRoot();
    const path = join(root, "retained.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(path, bytes);
    await expect(prompt("Describe", [path], initialized)).resolves.toEqual([
      { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
      { type: "text", text: "Describe" },
    ]);
    await expect(prompt("Describe", [path], { protocolVersion: 1, agentCapabilities: {} }))
      .rejects.toThrow("did not advertise image prompt support");
    await expect(prompt("Describe", [join(root, "unsupported.svg")], initialized))
      .rejects.toThrow("does not support the attached image type");
  });

  it("rejects a file grown beyond the retained attachment bound before reading it", async () => {
    const root = await fixtureRoot();
    const path = join(root, "grown.png");
    await writeFile(path, "retained bytes");
    await truncate(path, MAX_CHAT_ATTACHMENT_BYTES + 1);
    await expect(prompt("Describe", [path], initialized).then(() => undefined))
      .rejects.toThrow("10 MB safety limit");
  });

  it("keeps the aggregate limit while reading individually valid images", async () => {
    const root = await fixtureRoot();
    const path = join(root, "bounded.png");
    await writeFile(path, "");
    await truncate(path, MAX_CHAT_ATTACHMENT_BYTES);
    await expect(prompt("Describe", [path, path, path], initialized).then(() => undefined))
      .rejects.toThrow("20 MB safety limit");
  });

  it("rejects a different regular file substituted between stat and open", async () => {
    const root = await fixtureRoot();
    const selected = join(root, "selected.png");
    const replacement = join(root, "replacement.png");
    await writeFile(selected, "retained bytes");
    await writeFile(replacement, "unrelated bytes");
    const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      await rename(replacement, selected);
      return originalOpen(...args);
    });
    await expect(prompt("Describe", [selected], initialized))
      .rejects.toThrow("not a regular file");
  });

  it("reads the retained descriptor when the pathname changes after open", async () => {
    const root = await fixtureRoot();
    const selected = join(root, "selected.png");
    const replacement = join(root, "replacement.png");
    await writeFile(selected, "retained bytes");
    await writeFile(replacement, "unrelated bytes");
    const originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await originalOpen(...args);
      try {
        await rename(selected, join(root, "retained.png"));
        await rename(replacement, selected);
        return file;
      } catch (error) {
        await file.close();
        throw error;
      }
    });
    await expect(prompt("Describe", [selected], initialized)).resolves.toEqual([
      { type: "image", mimeType: "image/png", data: Buffer.from("retained bytes").toString("base64") },
      { type: "text", text: "Describe" },
    ]);
  });

  it.skipIf(process.platform === "win32")("rejects a pathname replaced by a symlink", async () => {
    const root = await fixtureRoot();
    const selected = join(root, "selected.png");
    const unrelated = join(root, "unrelated.png");
    await writeFile(selected, "retained bytes");
    await writeFile(unrelated, "unrelated bytes");
    await rm(selected);
    await symlink(unrelated, selected);
    await expect(prompt("Describe", [selected], initialized)).rejects.toThrow("not a regular file");
  });

  it("honors cancellation before opening another image", async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(prompt("Describe", ["must-not-open.png"], initialized, cancellation.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
