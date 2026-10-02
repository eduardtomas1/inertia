import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { CONVERSATION_ATTACHMENT_STORE_OPERATION_SOURCE } from "../../src/node/conversation-attachment-store-child";

const id = "11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from("retained attachment bytes");
let root: string;

const readerSource = `
  const { readFileSync } = require("node:fs");
  const promises = require("node:fs/promises");
  const { source, operation, emulation } = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (emulation !== "native") {
    Object.defineProperty(process, "platform", { value: "win32" });
  }
  const windowsStats = (stats) => {
    stats.uid = 0n;
    stats.gid = 0n;
    stats.mode = (stats.mode & ~0o777n) | (stats.isDirectory() ? 0o777n : 0o666n);
    if (emulation === "windows-zero-identity") {
      stats.dev = 0n;
      stats.ino = 0n;
    }
    return stats;
  };
  const windowsPromises = {
    ...promises,
    lstat: async (path, options) => windowsStats(await promises.lstat(path, options)),
    open: async (...args) => {
      const handle = await promises.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = async (options) => windowsStats(await stat(options));
      return handle;
    },
  };
  const perform = new Function(
    "require",
    source + "\\nreturn performConversationAttachmentStoreOperation;",
  )((name) => name === "node:fs/promises" && emulation !== "native"
    ? windowsPromises
    : require(name));
  perform(operation).then(
    (receipt) => process.stdout.write(JSON.stringify({
      missing: receipt.missing,
      bytes: receipt.missing ? 0 : Buffer.from(receipt.bytesBase64, "base64").length,
    })),
    (error) => process.stdout.write(JSON.stringify({ error: error.message })),
  );
`;

async function read(
  emulation: "native" | "windows" | "windows-zero-identity",
  identity: Partial<{ rootDev: string; rootIno: string; rootUid: string | null }> = {},
): Promise<unknown> {
  const canonical = await realpath(root);
  const entry = await lstat(canonical, { bigint: true });
  const zero = emulation === "windows-zero-identity";
  const request = join(root, "request.json");
  const reader = join(root, "reader.cjs");
  await writeFile(reader, readerSource);
  await writeFile(request, JSON.stringify({
    source: CONVERSATION_ATTACHMENT_STORE_OPERATION_SOURCE,
    emulation,
    operation: {
      operation: "read",
      root: canonical,
      rootDev: zero ? "0" : String(entry.dev),
      rootIno: zero ? "0" : String(entry.ino),
      rootUid: emulation === "native" ? String(entry.uid) : null,
      id,
      stallBeforeRecordRevalidateMs: 0,
      validateContent: true,
      ...identity,
    },
  }));
  return JSON.parse(execFileSync(process.execPath, [reader, request], {
    cwd: canonical,
    encoding: "utf8",
    timeout: 30_000,
  })) as unknown;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inertia-windows-identity-"));
  const record = join(root, id);
  await mkdir(record);
  await writeFile(join(record, "metadata.json"), JSON.stringify({
    id,
    extension: "png",
    size: bytes.length,
  }));
  await writeFile(join(record, `${id}.png`), bytes);
  await chmod(root, 0o755);
  await chmod(record, 0o755);
  await chmod(join(record, "metadata.json"), 0o644);
  await chmod(join(record, `${id}.png`), 0o644);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("reads a retained record whose Windows stats report uid 0 and non-private modes", async () => {
  await expect(read("windows")).resolves.toEqual({ missing: false, bytes: bytes.length });
});

it("reads a retained record whose Windows stats report zero device and file ids", async () => {
  await expect(read("windows-zero-identity")).resolves.toEqual({
    missing: false,
    bytes: bytes.length,
  });
});

it("still rejects a Windows root whose file id differs from the opened store", async () => {
  await expect(read("windows", { rootIno: "1" })).resolves.toEqual({
    error: "The attachment root authority changed.",
  });
});

it.runIf(process.platform !== "win32")(
  "rejects the same non-private record on POSIX",
  async () => {
    await expect(read("native")).resolves.toEqual({
      error: "The attachment root authority changed.",
    });
  },
);
