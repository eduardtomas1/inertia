import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { ConversationAttachmentStore,
  ConversationAttachmentStoreReconcilingError } from "../../src/node/conversation-attachment-store";
import { runConversationAttachmentStoreChild } from "../../src/node/conversation-attachment-store-child";
import { runPackagedImageRetentionSmoke } from "../../src/server/runtime/attachments/package-smoke-image";

const roots: string[] = [];
const stores: ConversationAttachmentStore[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY2BgYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC", "base64");

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function oldProfile() {
  const root = await mkdtemp(join(tmpdir(), "inertia-image-startup-")); roots.push(root);
  const input = join(root, "smoke.png"); await writeFile(input, png);
  const seeder = await ConversationAttachmentStore.open(root);
  const retentionId = randomUUID();
  const [historical] = await seeder.retain([{ attachment: {
    id: randomUUID(), name: "Saved before upgrade.png", path: input,
    mimeType: "image/png", size: png.length,
  }, bytes: png }], undefined, retentionId);
  seeder.acceptRetention(retentionId);
  await seeder.close();
  return { root, input, historical: historical! };
}

it("waits for pending startup reconciliation without changing ordinary retention admission or historical bytes", async () => {
  const f = await oldProfile();
  const candidate = await ConversationAttachmentStore.open(f.root, { reconciliationBatchEntries: 1 });
  stores.push(candidate);
  // Hold the scheduled 25 ms continuation, not filesystem work or native
  // child events. This recreates the worker's immediate-after-ready caller.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await candidate.reconcile([f.historical]);
  await expect(candidate.retain([{ attachment: f.historical, bytes: png }]))
    .rejects.toBeInstanceOf(ConversationAttachmentStoreReconcilingError);
  const result = join(f.root, "early-result.json");
  const originalRetain = candidate.retain.bind(candidate);
  let markAdmission!: () => void;
  const admissionStarted = new Promise<void>((resolve) => { markAdmission = resolve; });
  vi.spyOn(candidate, "retain").mockImplementationOnce((...args) => {
    markAdmission(); return originalRetain(...args);
  });
  const smoking = runPackagedImageRetentionSmoke(f.input, result, candidate);
  // Let actual file I/O complete without advancing the held continuation.
  await admissionStarted;
  await expect(readFile(result)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.historical.path)).toEqual(png);
  await vi.advanceTimersByTimeAsync(25);
  await candidate.usage();
  await vi.advanceTimersByTimeAsync(25);
  await smoking;
  expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ ok: true });
  expect(await readFile(f.historical.path)).toEqual(png);
  await candidate.close(); stores.splice(stores.indexOf(candidate), 1);
  vi.useRealTimers();
});

it("makes no progress when each real read child exceeds the unchanged 250 ms batch, then progresses after the delay is removed", async () => {
  const f = await oldProfile();
  let stallMs = 300;
  let attempts = 0;
  let aborted = 0;
  let completed = 0;
  const receipts: Promise<void>[] = [];
  const candidate = await ConversationAttachmentStore.open(f.root, {
    readOperationRunner: (operation, signal) => {
      attempts++;
      const child = runConversationAttachmentStoreChild({ ...operation,
        stallBeforeRecordRevalidateMs: stallMs,
      }, signal);
      receipts.push(child.stopped);
      void child.result.then(() => { completed++; }, () => { if (signal?.aborted) aborted++; });
      return child;
    },
  });
  stores.push(candidate);
  await candidate.reconcile([f.historical]);
  const result = join(f.root, "slow-result.json");
  const smoking = runPackagedImageRetentionSmoke(f.input, result, candidate);
  await vi.waitFor(() => expect(aborted).toBeGreaterThanOrEqual(3), { timeout: 3_000 });
  expect(attempts).toBeGreaterThanOrEqual(3);
  expect(completed).toBe(0);
  await expect(readFile(result)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.historical.path)).toEqual(png);

  stallMs = 0;
  await smoking;
  expect(completed).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ ok: true });
  expect(await readFile(f.historical.path)).toEqual(png);
  await candidate.close(); stores.splice(stores.indexOf(candidate), 1);
  await Promise.all(receipts);
});

it("cancels the real preview child through the smoke's optional signal without damaging retained bytes", async () => {
  const f = await oldProfile();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const reader = await ConversationAttachmentStore.open(f.root, {
    readFault: { attachmentId: f.historical.id, stallBeforeRecordRevalidateMs: 2_000, onReady: markReady },
  });
  stores.push(reader);
  const controller = new AbortController();
  const cancellation = new Error("Image smoke deadline cancelled preview.");
  const reading = reader.preview(f.historical.id, controller.signal).catch((error: unknown) => error);
  await ready;
  controller.abort(cancellation);
  expect(await reading).toBe(cancellation);
  await reader.close(); stores.splice(stores.indexOf(reader), 1);
  expect(await readFile(f.historical.path)).toEqual(png);
});
