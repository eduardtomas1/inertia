import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import type { UtilityProcess } from "electron";
import { describe, expect, it, vi } from "vitest";

import type {
  AttachmentImportFileOperation,
  AttachmentImportValidationReceipt,
} from "../../src/main/attachment-import-file";
import {
  createAttachmentImportUtilityRunner,
} from "../../src/main/attachment-import-runner";

const operation: AttachmentImportFileOperation = {
  root: resolve("/tmp", "inertia-attachment-import"),
  rootDev: "1",
  rootIno: "2",
  rootUid: "501",
  fileName: "11111111-1111-4111-8111-111111111111.pdf",
  name: "brief.pdf",
  mimeType: "application/pdf",
  size: 100,
  stallBeforeValidationMs: 0,
};

const receipt: AttachmentImportValidationReceipt = {
  displayName: "brief.pdf",
  mimeType: "application/pdf",
  extension: "pdf",
  size: 100,
  digest: "a".repeat(64),
};

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
}

function utility(child: FakeUtilityProcess): UtilityProcess {
  return child as unknown as UtilityProcess;
}

function reportSuccess(child: FakeUtilityProcess): void {
  child.emit("spawn");
  child.emit("message", {
    type: "attachment-import.result",
    ok: true,
    receipt,
  });
  child.emit("exit", 0);
}

describe("supervised attachment import utility", () => {
  it("waits for exact utility exit after a valid receipt", async () => {
    const child = new FakeUtilityProcess();
    const runner = createAttachmentImportUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    child.emit("message", {
      type: "attachment-import.result",
      ok: true,
      receipt,
    });
    const settled = vi.fn();
    void running.result.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    child.emit("exit", 0);
    await expect(running.result).resolves.toEqual(receipt);
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("maps a structural rejection without exposing worker details", async () => {
    const child = new FakeUtilityProcess();
    const runner = createAttachmentImportUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    child.emit("message", {
      type: "attachment-import.result",
      ok: false,
      code: "content",
    });
    child.emit("exit", 1);

    await expect(running.result).rejects.toThrow(
      "Attachment content does not match its safe file type.",
    );
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("kills malformed and duplicate result producers", async () => {
    for (const events of [
      [{ invalid: true }],
      [
        { type: "attachment-import.result", ok: true, receipt },
        { type: "attachment-import.result", ok: true, receipt },
      ],
    ]) {
      const child = new FakeUtilityProcess();
      const runner = createAttachmentImportUtilityRunner({
        spawn: () => utility(child),
      });
      const running = runner(operation);
      child.emit("spawn");
      for (const event of events) child.emit("message", event);
      expect(child.kill).toHaveBeenCalledOnce();
      child.emit("exit", 1);
      await expect(running.result).rejects.toThrow(/invalid result/u);
      await expect(running.stopped).resolves.toBeUndefined();
    }
  });

  it("cancels an active worker and confirms its exact exit", async () => {
    const child = new FakeUtilityProcess();
    const controller = new AbortController();
    const runner = createAttachmentImportUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation, controller.signal);
    child.emit("spawn");
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1);

    await expect(running.result).rejects.toThrow(/cancelled/u);
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("retries a pre-spawn cancellation kill after startup", async () => {
    const children: FakeUtilityProcess[] = [];
    const controller = new AbortController();
    const runner = createAttachmentImportUtilityRunner({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        return utility(child);
      },
    });
    const running = runner(operation, controller.signal);
    children[0]!.kill.mockReturnValueOnce(false);

    controller.abort();
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    children[0]!.emit("spawn");
    expect(children[0]!.kill).toHaveBeenCalledTimes(2);
    expect(children[0]!.postMessage).not.toHaveBeenCalled();
    children[0]!.emit("exit", 1);

    await expect(running.result).rejects.toThrow(/cancelled/u);
    await expect(running.stopped).resolves.toBeUndefined();

    const future = runner(operation);
    expect(children).toHaveLength(2);
    reportSuccess(children[1]!);
    await expect(future.result).resolves.toEqual(receipt);
  });

  it("bounds active and pending attachment validation memory", async () => {
    const children: FakeUtilityProcess[] = [];
    const runner = createAttachmentImportUtilityRunner({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        return utility(child);
      },
      maxActiveOperations: 1,
      maxPendingOperations: 1,
    });
    const first = runner(operation);
    const queued = runner({ ...operation, fileName: operation.fileName.replace(
      "11111111",
      "22222222",
    ) });
    const overflow = runner({ ...operation, fileName: operation.fileName.replace(
      "11111111",
      "33333333",
    ) });
    void first.result.catch(() => undefined);

    expect(children).toHaveLength(1);
    await expect(overflow.result).rejects.toThrow(/bounded capacity/u);
    await expect(overflow.stopped).resolves.toBeUndefined();

    reportSuccess(children[0]!);
    await expect(first.result).resolves.toEqual(receipt);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    reportSuccess(children[1]!);
    await expect(queued.result).resolves.toEqual(receipt);
  });

  it("cancels queued validation without spawning it", async () => {
    const children: FakeUtilityProcess[] = [];
    const runner = createAttachmentImportUtilityRunner({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        return utility(child);
      },
      maxActiveOperations: 1,
      maxPendingOperations: 1,
    });
    const active = runner(operation);
    void active.result.catch(() => undefined);
    const controller = new AbortController();
    const queued = runner({ ...operation, fileName: operation.fileName.replace(
      "11111111",
      "22222222",
    ) }, controller.signal);
    controller.abort();

    await expect(queued.result).rejects.toThrow(/cancelled/u);
    await expect(queued.stopped).resolves.toBeUndefined();
    expect(children).toHaveLength(1);
    reportSuccess(children[0]!);
    await expect(active.result).resolves.toEqual(receipt);
  });

  it("fails closed when timeout shutdown cannot be confirmed", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeUtilityProcess();
      const runner = createAttachmentImportUtilityRunner({
        spawn: () => utility(child),
        timeoutMs: 20,
        killGraceMs: 10,
      });
      const running = runner(operation);
      void running.result.catch(() => undefined);
      void running.stopped.catch(() => undefined);
      child.emit("spawn");
      await vi.advanceTimersByTimeAsync(30);

      expect(child.kill).toHaveBeenCalledOnce();
      await expect(running.result).rejects.toThrow(/timed out/u);
      await expect(running.stopped).rejects.toThrow(/unconfirmed/u);
      await expect(runner.shutdown?.()).resolves.toBe(false);
      const future = runner(operation);
      await expect(future.result).rejects.toThrow(/unconfirmed/u);
      await expect(future.stopped).rejects.toThrow(/unconfirmed/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown cancels active validation and waits for exit", async () => {
    const child = new FakeUtilityProcess();
    const runner = createAttachmentImportUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    const shutdown = runner.shutdown!();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1);

    await expect(running.result).rejects.toThrow(/cancelled/u);
    await expect(shutdown).resolves.toBe(true);
  });
});
