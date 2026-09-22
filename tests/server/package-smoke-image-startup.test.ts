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
  const orphans = [".orphan-first", ".orphan-second"];
  for (const orphan of orphans) await writeFile(join(seeder.directory, orphan), "orphan");
  await seeder.close();
  return { root, input, historical: historical!, orphans };
}

type RemoveRunner = NonNullable<Parameters<typeof ConversationAttachmentStore.open>[1]>["operationRunner"];

function delayedRemoval(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function slowRemovals(
  delayMs: number,
  observe: (attempt: number, operation: Parameters<NonNullable<RemoveRunner>>[0], signal: AbortSignal | undefined) =>
    { result: Promise<void>; stopped: Promise<void> } | null = () => null,
): NonNullable<RemoveRunner> {
  let attempts = 0;
  return (operation, signal) => {
    if (operation.operation !== "remove") return runConversationAttachmentStoreChild(operation, signal);
    const custom = observe(++attempts, operation, signal);
    if (custom) return custom;
    const result = delayedRemoval(delayMs, signal)
      .then(() => runConversationAttachmentStoreChild(operation, signal).result);
    return { result, stopped: result.then(() => undefined, () => undefined) };
  };
}

it("waits for pending startup cleanup without changing ordinary retention admission or historical bytes", async () => {
  const f = await oldProfile();
  const candidate = await ConversationAttachmentStore.open(f.root, { reconciliationBatchEntries: 1 });
  stores.push(candidate);
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
  await admissionStarted;
  await expect(readFile(result)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.historical.path)).toEqual(png);
  for (let step = 0; step < 4; step += 1) {
    await vi.advanceTimersByTimeAsync(25);
    await candidate.usage();
  }
  await smoking;
  expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ ok: true });
  expect(await readFile(f.historical.path)).toEqual(png);
  await candidate.close(); stores.splice(stores.indexOf(candidate), 1);
  vi.useRealTimers();
});

it("keeps startup bounded without reading history and completes slow background cleanup", async () => {
  const f = await oldProfile();
  let reads = 0;
  let aborted = 0;
  let completed = 0;
  const candidate = await ConversationAttachmentStore.open(f.root, {
    readOperationRunner: (operation, signal) => {
      reads++;
      return runConversationAttachmentStoreChild(operation, signal);
    },
    operationRunner: slowRemovals(300, (_attempt, operation, signal) => {
      const result = delayedRemoval(300, signal)
        .then(() => runConversationAttachmentStoreChild(operation, signal).result);
      void result.then(() => { completed++; }, () => { if (signal?.aborted) aborted++; });
      return { result, stopped: result.then(() => undefined, () => undefined) };
    }),
  });
  stores.push(candidate);
  const startedAt = Date.now();
  await candidate.reconcile([f.historical]);
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(reads).toBe(0);
  expect(aborted).toBe(1);
  expect(completed).toBe(0);
  const result = join(f.root, "slow-result.json");
  const controller = new AbortController();
  const smoking = runPackagedImageRetentionSmoke(f.input, result, candidate, controller.signal)
    .catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(completed).toBe(2), { timeout: 5_000 });
    expect(await smoking).toBeUndefined();
    expect(aborted).toBe(1);
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ ok: true });
    expect(await readFile(f.historical.path)).toEqual(png);
  } finally {
    controller.abort(); await smoking;
    await candidate.close(); stores.splice(stores.indexOf(candidate), 1);
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

it("cancels an admitted background cleanup helper on store close and waits for its exact stop confirmation", async () => {
  const f = await oldProfile();
  let attempts = 0;
  let backgroundSignal: AbortSignal | undefined;
  let actualStop: Promise<void> | undefined;
  let releaseConfirmation!: () => void;
  const confirmation = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
  const candidate = await ConversationAttachmentStore.open(f.root, {
    operationRunner: slowRemovals(300, (attempt, _operation, signal) => {
      attempts = attempt;
      if (attempt !== 2) return null;
      backgroundSignal = signal;
      const result = delayedRemoval(60_000, signal);
      actualStop = result.then(() => undefined, () => undefined);
      return { result, stopped: actualStop.then(() => confirmation) };
    }),
  });
  stores.push(candidate);
  try {
    await candidate.reconcile([f.historical]);
    await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 2_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(backgroundSignal?.aborted).toBe(false);
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

it("fails closed on a background cleanup error after the admission deadline without deleting historical bytes", async () => {
  const f = await oldProfile();
  let backgroundFailed = false;
  const removals: string[] = [];
  const failure = new Error("Background store helper returned an invalid receipt.");
  const candidate = await ConversationAttachmentStore.open(f.root, {
    operationRunner: slowRemovals(300, (attempt, operation, signal) => {
      if (operation.operation === "remove") removals.push(operation.name);
      if (attempt === 1) return null;
      const result = delayedRemoval(10, signal).then(() => {
        backgroundFailed = true; throw failure;
      });
      return { result, stopped: result.then(() => undefined, () => undefined) };
    }),
  });
  stores.push(candidate);
  await candidate.reconcile([f.historical]);
  await vi.waitFor(() => expect(backgroundFailed).toBe(true), { timeout: 2_000 });
  await vi.waitFor(async () => {
    await expect(candidate.retain([{ attachment: f.historical, bytes: png }]))
      .rejects.toThrow("Conversation attachment storage reconciliation failed.");
  });
  expect(removals.every((name) => f.orphans.includes(name))).toBe(true);
  expect(await readFile(f.historical.path)).toEqual(png);
  await candidate.close(); stores.splice(stores.indexOf(candidate), 1);
});
