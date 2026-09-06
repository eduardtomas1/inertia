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

it("keeps startup bounded and completes real 300 ms background reads without reducing their delay", async () => {
  const f = await oldProfile();
  let attempts = 0;
  let aborted = 0;
  let completed = 0;
  const receipts: Promise<void>[] = [];
  const candidate = await ConversationAttachmentStore.open(f.root, {
    readOperationRunner: (operation, signal) => {
      attempts++;
      const child = runConversationAttachmentStoreChild({ ...operation,
        stallBeforeRecordRevalidateMs: 300,
      }, signal);
      receipts.push(child.stopped);
      void child.result.then(() => { completed++; }, () => { if (signal?.aborted) aborted++; });
      return child;
    },
  });
  stores.push(candidate);
  await candidate.reconcile([f.historical]);
  expect(aborted).toBe(1);
  expect(completed).toBe(0);
  expect(attempts).toBe(1);
  const result = join(f.root, "slow-result.json");
  const controller = new AbortController();
  const smoking = runPackagedImageRetentionSmoke(f.input, result, candidate, controller.signal)
    .catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(completed).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
    expect(await smoking).toBeUndefined();
    expect(aborted).toBe(1);
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ ok: true });
    expect(await readFile(f.historical.path)).toEqual(png);
  } finally {
    controller.abort(); await smoking;
    await candidate.close(); stores.splice(stores.indexOf(candidate), 1);
    await Promise.all(receipts);
  }
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

it("cancels an admitted background helper on store close and waits for its exact stop confirmation", async () => {
  const f = await oldProfile();
  let attempts = 0;
  let backgroundReady = false;
  let backgroundSignal: AbortSignal | undefined;
  let actualStop: Promise<void> | undefined;
  let releaseConfirmation!: () => void;
  const confirmation = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
  const candidate = await ConversationAttachmentStore.open(f.root, {
    readOperationRunner: (operation, signal) => {
      const attempt = ++attempts;
      const child = runConversationAttachmentStoreChild({ ...operation,
        stallBeforeRecordRevalidateMs: 2_000,
      }, signal);
      if (attempt !== 2) return child;
      backgroundSignal = signal;
      actualStop = child.stopped;
      void child.ready?.then((ready) => { backgroundReady = ready; });
      // The actual child must stop first. Hold only its confirmation delivery
      // to prove store.close does not treat cancellation as completed cleanup.
      return { ...child, stopped: child.stopped.then(() => confirmation) };
    },
  });
  stores.push(candidate);
  try {
    await candidate.reconcile([f.historical]);
    await vi.waitFor(() => expect(backgroundReady).toBe(true), { timeout: 2_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(backgroundSignal?.aborted).toBe(false);
    expect(attempts).toBe(2);
    let closed = false;
    const closing = candidate.close().then(() => { closed = true; });
    expect(backgroundSignal?.aborted).toBe(true);
    await actualStop;
    expect(closed).toBe(false);
    releaseConfirmation();
    await closing;
    expect(closed).toBe(true);
    expect(await readFile(f.historical.path)).toEqual(png);
  } finally {
    releaseConfirmation();
    await candidate.close(); stores.splice(stores.indexOf(candidate), 1);
  }
});

it("fails closed on a background read error after the admission deadline without deleting historical bytes", async () => {
  const f = await oldProfile();
  let attempts = 0;
  let backgroundFailed = false;
  const removals: string[] = [];
  const failure = new Error("Background store helper returned an invalid receipt.");
  const candidate = await ConversationAttachmentStore.open(f.root, {
    operationRunner: (operation, signal) => {
      if (operation.operation === "remove") removals.push(operation.name);
      return runConversationAttachmentStoreChild(operation, signal);
    },
    readOperationRunner: (operation, signal) => {
      const attempt = ++attempts;
      const child = runConversationAttachmentStoreChild({ ...operation,
        stallBeforeRecordRevalidateMs: 300,
      }, signal);
      if (attempt === 1) return child;
      return { ...child, result: child.result.then(() => {
        backgroundFailed = true; throw failure;
      }) };
    },
  });
  stores.push(candidate);
  await candidate.reconcile([f.historical]);
  await vi.waitFor(() => expect(backgroundFailed).toBe(true), { timeout: 2_000 });
  await vi.waitFor(async () => {
    await expect(candidate.retain([{ attachment: f.historical, bytes: png }]))
      .rejects.toThrow("Conversation attachment storage reconciliation failed.");
  });
  expect(attempts).toBe(2);
  expect(removals).toEqual([]);
  expect(await readFile(f.historical.path)).toEqual(png);
  await candidate.close(); stores.splice(stores.indexOf(candidate), 1);
});
