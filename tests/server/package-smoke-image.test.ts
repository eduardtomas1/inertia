import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { ConversationAttachmentStoreReconcilingError,
  type ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { runPackagedImageRetentionSmoke } from "../../src/server/runtime/attachments/package-smoke-image";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-smoke-admission-")); roots.push(root);
  const input = join(root, "input.png");
  const result = join(root, "result.json");
  const bytes = Buffer.from("exact smoke image bytes");
  await writeFile(input, bytes);
  const retain = vi.fn(async () => [{ id: "retained-image" }]);
  const preview = vi.fn(async (_id: string, _signal?: AbortSignal) => ({ bytes }));
  const acceptRetention = vi.fn();
  return { input, result, bytes, retain, preview, acceptRetention,
    store: { retain, preview, acceptRetention } as unknown as ConversationAttachmentStore };
}

it("retries only typed pre-publication busy admission and performs one retained-byte proof", async () => {
  const f = await fixture();
  f.retain.mockRejectedValueOnce(new ConversationAttachmentStoreReconcilingError())
    .mockRejectedValueOnce(new ConversationAttachmentStoreReconcilingError());
  await runPackagedImageRetentionSmoke(f.input, f.result, f.store);
  expect(f.retain).toHaveBeenCalledTimes(3);
  const calls = f.retain.mock.calls as unknown as [unknown, AbortSignal, string][];
  expect(calls.every((call) => call[0] === calls[0]![0] && call[1] === calls[0]![1]
    && call[2] === "00000000-0000-4000-8000-000000000019")).toBe(true);
  expect(f.preview).toHaveBeenCalledExactlyOnceWith("retained-image", calls[0]![1]);
  expect(f.acceptRetention).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.result, "utf8"))).toEqual({ ok: true });
});

it.each([
  "Conversation attachment storage is still reconciling.",
  "Conversation attachment storage reconciliation failed.",
  "Conversation attachment storage is full.",
  "Publication failed after partial I/O.",
])("does not retry an ordinary error: %s", async (message) => {
  const f = await fixture();
  const failure = new Error(message);
  f.retain.mockRejectedValue(failure);
  await expect(runPackagedImageRetentionSmoke(f.input, f.result, f.store)).rejects.toBe(failure);
  expect(f.retain).toHaveBeenCalledOnce();
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.acceptRetention).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.result, "utf8"))).toEqual({ ok: false, message });
});

it("keeps input I/O failure immediate without attempting admission", async () => {
  const f = await fixture();
  await expect(runPackagedImageRetentionSmoke(`${f.input}.missing`, f.result, f.store))
    .rejects.toMatchObject({ code: "ENOENT" });
  expect(f.retain).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.result, "utf8"))).toMatchObject({ ok: false });
});

it("keeps preview validation failure final instead of replaying a retained write", async () => {
  const f = await fixture();
  f.preview.mockResolvedValue({ bytes: Buffer.from("wrong bytes") });
  await expect(runPackagedImageRetentionSmoke(f.input, f.result, f.store))
    .rejects.toThrow("returned invalid bytes");
  expect(f.retain).toHaveBeenCalledOnce();
  expect(f.acceptRetention).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.result, "utf8"))).toMatchObject({ ok: false });
});

it("cancels a busy wait with the worker signal without admitting a later write", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const cancellation = new Error("Worker shutdown cancelled image smoke.");
  f.retain.mockRejectedValue(new ConversationAttachmentStoreReconcilingError());
  const smoking = runPackagedImageRetentionSmoke(f.input, f.result, f.store, controller.signal)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.retain).toHaveBeenCalled());
  controller.abort(cancellation);
  expect(await smoking).toBe(cancellation);
  const attempts = f.retain.mock.calls.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(f.retain).toHaveBeenCalledTimes(attempts);
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.acceptRetention).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.result, "utf8"))).toEqual({ ok: false, message: cancellation.message });
});

it("ends permanently busy admission at one absolute 30-second deadline", async () => {
  const f = await fixture(); vi.useFakeTimers();
  f.retain.mockRejectedValue(new ConversationAttachmentStoreReconcilingError());
  const startedAt = Date.now();
  let settled = false;
  const smoking = runPackagedImageRetentionSmoke(f.input, f.result, f.store)
    .catch((error: unknown) => { settled = true; return error; });
  await vi.waitFor(() => expect(f.retain).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(29_999 - (Date.now() - startedAt));
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await smoking).toEqual(new Error("The packaged image retention smoke exceeded its deadline."));
  expect(Date.now() - startedAt).toBe(30_000);
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.acceptRetention).not.toHaveBeenCalled();
  // A deadline failure gets no new, uncancelled receipt-writing budget.
  await expect(readFile(f.result)).rejects.toMatchObject({ code: "ENOENT" });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not reset the budget after admission and passes cancellation into preview", async () => {
  const f = await fixture(); vi.useFakeTimers();
  f.retain.mockRejectedValueOnce(new ConversationAttachmentStoreReconcilingError());
  f.preview.mockImplementation((_id, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const startedAt = Date.now();
  const smoking = runPackagedImageRetentionSmoke(f.input, f.result, f.store)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.preview).toHaveBeenCalledOnce());
  expect(f.preview.mock.calls[0]![1]?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000 - (Date.now() - startedAt));
  expect(await smoking).toEqual(new Error("The packaged image retention smoke exceeded its deadline."));
  expect(f.preview.mock.calls[0]![1]?.aborted).toBe(true);
  expect(f.retain).toHaveBeenCalledTimes(2);
  expect(f.acceptRetention).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
