import { describe, expect, it, vi } from "vitest";
import { RuntimeDocumentPreparationCoordinator } from "../../src/main/runtime-document-preparation-coordinator";
import type { RuntimeProcessRecord } from "../../src/main/runtime-supervisor-types";
import type { DocumentPreparationResult } from "../../src/node/document-preparation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const output: DocumentPreparationResult = {
  contexts: [{ attachmentId: "pdf", label: "PDF", content: "text", truncated: false }], images: [], imageOrder: [],
};
const request = {
  type: "runtime.document-preparation-request" as const, requestId: "11111111-1111-4111-8111-111111111111",
  operation: { deadlineAt: Date.now() + 10_000, payloads: [{ id: "pdf", name: "Document.pdf", mimeType: "application/pdf" as const, bytes: new Uint8Array([1]) }] },
};
const record = {} as RuntimeProcessRecord;
const otherRecord = {} as RuntimeProcessRecord;

function fixture(retryUnconfirmedShutdown = false) {
  const result = deferred<DocumentPreparationResult>();
  const stopped = deferred<void>();
  const termination = deferred<void>();
  const runner = vi.fn((_operation: unknown, _signal?: AbortSignal) => ({ result: result.promise, stopped: stopped.promise, termination: termination.promise }));
  const post = vi.fn();
  const coordinator = new RuntimeDocumentPreparationCoordinator({ runner, post, accepts: () => true, retryUnconfirmedShutdown });
  return { result, stopped, termination, runner, post, coordinator };
}

describe("main-owned document decoder correlation", () => {
  it("waits for output and exit before acknowledging the exact runtime request", async () => {
    const f = fixture();
    f.coordinator.handle(record, request);
    f.result.resolve(output);
    await Promise.resolve();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.coordinator.hasOperations(record)).toBe(true);
    f.stopped.resolve();
    f.termination.resolve();
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledWith(record, {
      type: "runtime.document-preparation-result", requestId: request.requestId, ok: true, shutdownConfirmed: true, result: output,
    }));
    await expect(f.coordinator.drain(record)).resolves.toBe(true);
  });

  it("rejects replay and prevents a different runtime from cancelling an owned operation", async () => {
    const f = fixture();
    f.coordinator.handle(record, request);
    f.coordinator.handle(record, request);
    expect(f.runner).toHaveBeenCalledOnce();
    expect(f.post).toHaveBeenCalledWith(record, expect.objectContaining({ ok: false }));
    const signal = f.runner.mock.calls[0]![1]!;
    const cancellation = { type: "runtime.document-preparation-cancel" as const, requestId: request.requestId };
    f.coordinator.handle(otherRecord, cancellation);
    expect(signal.aborted).toBe(false);
    f.coordinator.handle(record, cancellation);
    expect(signal.aborted).toBe(true);
    f.result.reject(new Error("cancelled"));
    f.stopped.resolve();
    f.termination.resolve();
    await expect(f.coordinator.drain(record)).resolves.toBe(true);
  });

  it.each([false, true])("keeps rejected cleanup fenced, with late-exit retry policy %s", async (retry) => {
    const f = fixture(retry);
    f.coordinator.handle(record, request);
    f.result.resolve(output);
    f.stopped.reject(undefined);
    await expect(f.coordinator.drain(record)).resolves.toBe(false);
    expect(f.post).toHaveBeenCalledWith(record, expect.objectContaining({ ok: false, shutdownConfirmed: false }));
    expect(f.coordinator.hasOperations(record)).toBe(true);
    f.termination.resolve();
    await Promise.resolve();
    await expect(f.coordinator.drain(record)).resolves.toBe(retry);
  });

  it("does not turn an arbitrary synchronous runner throw into a no-spawn proof", async () => {
    const post = vi.fn();
    const coordinator = new RuntimeDocumentPreparationCoordinator({
      runner: () => { throw new Error("unknown runner phase"); }, post, accepts: () => true,
    });
    coordinator.handle(record, request);
    expect(post).toHaveBeenCalledWith(record, expect.objectContaining({ ok: false, shutdownConfirmed: false }));
    await expect(coordinator.shutdown()).resolves.toBe(false);
  });

  it("rejects an unrelated result while keeping its observed cleanup proof", async () => {
    const f = fixture();
    f.coordinator.handle(record, request);
    f.result.resolve({ ...output, contexts: [] });
    f.stopped.resolve();
    f.termination.resolve();
    await expect(f.coordinator.drain(record)).resolves.toBe(true);
    expect(f.post).toHaveBeenCalledWith(record, expect.objectContaining({ ok: false, shutdownConfirmed: true }));
  });

  it("suppresses stale replies during forced teardown without releasing unconfirmed ownership", async () => {
    const f = fixture();
    f.coordinator.handle(record, request);
    const draining = f.coordinator.drain(record, true);
    expect(f.runner.mock.calls[0]![1]!.aborted).toBe(true);
    f.result.reject(new Error("cancelled"));
    f.stopped.reject(new Error("unconfirmed"));
    await expect(draining).resolves.toBe(false);
    expect(f.post).not.toHaveBeenCalled();
    f.termination.resolve();
  });
});
