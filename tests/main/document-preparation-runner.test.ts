import { EventEmitter } from "node:events";
import type { UtilityProcess } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentPreparationRunner } from "../../src/main/document-preparation-runner";
import type { DocumentPreparationExecution, DocumentPreparationOperation } from "../../src/node/document-preparation";

class Child extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
}
const operation = (deadlineAt = Date.now() + 10_000): DocumentPreparationOperation => ({
  deadlineAt,
  payloads: [{ id: "pdf-1", name: "Document.pdf", mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }],
});
const result = { contexts: [{ attachmentId: "pdf-1", label: "PDF", content: "Page text.", truncated: false }], images: [], imageOrder: [] };
const operationId = (child: Child): string => child.postMessage.mock.calls[0]![0].operationId as string;
function report(child: Child): void {
  child.emit("message", { type: "document.result", operationId: operationId(child), ok: true, result });
}
function finish(child: Child): void {
  child.emit("spawn");
  report(child);
  child.emit("exit", 0);
}
function fixture() {
  const children: Child[] = [];
  const spawn = vi.fn(() => {
    const child = new Child();
    children.push(child);
    return child as unknown as UtilityProcess;
  });
  return { children, spawn, runner: createDocumentPreparationRunner({ spawn, killGraceMs: 20 }) };
}
afterEach(() => { vi.useRealTimers(); });

describe("isolated document preparation ownership", () => {
  it("releases a validated result only after the matching decoder exits", async () => {
    const { runner, children } = fixture();
    const running = runner(operation());
    const settled = vi.fn();
    void running.result.then(settled);
    const child = children[0]!;
    child.emit("spawn");
    report(child);
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: "document.result-ack", operationId: operationId(child) });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit("exit", 0);
    await expect(running.result).resolves.toEqual(result);
    await expect(running.stopped).resolves.toBeUndefined();
    await expect(running.termination).resolves.toBeUndefined();
  });

  it.each(["foreign identity", "foreign attachment", "extra field", "duplicate result"])("kills a decoder reporting %s", async (kind) => {
    const { runner, children } = fixture();
    const running = runner(operation());
    const rejected = expect(running.result).rejects.toThrow("invalid result");
    const child = children[0]!;
    child.emit("spawn");
    if (kind === "duplicate result") report(child);
    child.emit("message", {
      type: "document.result", operationId: kind === "foreign identity" ? "11111111-1111-4111-8111-111111111111" : operationId(child), ok: true,
      result: kind === "foreign attachment" ? { ...result, contexts: [] } : result,
      ...(kind === "extra field" ? { unexpected: true } : {}),
    });
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1);
    await rejected;
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("rejects process failure and exit without acknowledgement", async () => {
    const { runner, children } = fixture();
    const running = runner(operation());
    const rejected = expect(running.result).rejects.toThrow("stopped unexpectedly");
    children[0]!.emit("exit", 9);
    await rejected;
    await expect(running.stopped).resolves.toBeUndefined();
    const next = runner(operation());
    finish(children[1]!);
    await expect(next.result).resolves.toEqual(result);
  });

  it("retries cancellation at spawn when the pre-spawn kill was not accepted", async () => {
    const { runner, children } = fixture();
    const controller = new AbortController();
    const running = runner(operation(), controller.signal);
    const rejected = expect(running.result).rejects.toThrow("cancelled");
    const child = children[0]!;
    child.kill.mockReturnValueOnce(false);
    controller.abort();
    child.emit("spawn");
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.postMessage).not.toHaveBeenCalled();
    child.emit("exit", 1);
    await rejected;
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("bounds active and queued work, then admits the next request only after exit", async () => {
    const { runner, children, spawn } = fixture();
    const first = runner(operation());
    const second = runner(operation());
    const third = runner(operation());
    const excess = runner(operation());
    await expect(excess.result).rejects.toThrow("bounds");
    await expect(excess.stopped).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
    children[0]!.emit("spawn");
    report(children[0]!);
    expect(spawn).toHaveBeenCalledOnce();
    children[0]!.emit("exit", 0);
    expect(spawn).toHaveBeenCalledTimes(2);
    finish(children[1]!);
    finish(children[2]!);
    await expect(Promise.all([first.result, second.result, third.result])).resolves.toHaveLength(3);
  });

  it("expires queued work at its own deadline without spawning it", async () => {
    vi.useFakeTimers();
    const { runner, children, spawn } = fixture();
    const first = runner(operation());
    const queued = runner(operation(Date.now() + 10));
    const rejected = expect(queued.result).rejects.toThrow("expired while queued");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    await expect(queued.stopped).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
    finish(children[0]!);
    await first.result;
  });

  it("retains unconfirmed ownership and rejects new work even after a late exit", async () => {
    vi.useFakeTimers();
    const { runner, children, spawn } = fixture();
    const running = runner(operation(Date.now() + 10));
    const queued = runner(operation());
    const resultFailure = expect(running.result).rejects.toThrow("timed out");
    const stopFailure = expect(running.stopped).rejects.toThrow("shutdown is unconfirmed");
    const queueFailure = expect(queued.result).rejects.toThrow("shutdown is unconfirmed");
    const termination = vi.fn();
    void running.termination.then(termination);
    children[0]!.emit("spawn");
    await vi.advanceTimersByTimeAsync(30);
    await Promise.all([resultFailure, stopFailure, queueFailure]);
    expect(termination).not.toHaveBeenCalled();
    children[0]!.emit("exit", 1);
    await running.termination;
    expect(termination).toHaveBeenCalledOnce();
    await expect(runner(operation()).result).rejects.toThrow("shutdown is unconfirmed");
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("does not spawn for invalid, expired or pre-cancelled requests", async () => {
    const { runner, spawn } = fixture();
    const controller = new AbortController();
    controller.abort();
    const cases: DocumentPreparationExecution[] = [
      runner({ ...operation(), payloads: [] }), runner(operation(Date.now() - 1)), runner(operation(), controller.signal),
    ];
    for (const running of cases) {
      await expect(running.result).rejects.toThrow("unavailable");
      await expect(running.stopped).resolves.toBeUndefined();
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
