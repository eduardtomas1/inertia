import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import type { UtilityProcess } from "electron";
import { describe, expect, it, vi } from "vitest";

import { createConversationAttachmentStoreUtilityRunner } from "../../src/main/conversation-attachment-store-runner";

const operation = {
  operation: "remove" as const,
  root: resolve("/tmp", "conversation-attachments"),
  rootDev: "1",
  rootIno: "2",
  rootUid: "501",
  name: "11111111-1111-4111-8111-111111111111",
};

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
}

function utility(child: FakeUtilityProcess): UtilityProcess {
  return child as unknown as UtilityProcess;
}

function operationId(child: FakeUtilityProcess): string {
  const request = child.postMessage.mock.calls
    .map(([value]) => value as Record<string, unknown>)
    .find(({ type }) => type === "conversation-attachment-store.perform");
  expect(request?.operationId).toEqual(expect.any(String));
  return request!.operationId as string;
}

function reportResult(child: FakeUtilityProcess, ok = true): void {
  child.emit("message", {
    type: "conversation-attachment-store.result",
    operationId: operationId(child),
    ok,
  });
}

describe("conversation attachment store utility runner", () => {
  it("waits for exit after a valid result", async () => {
    const child = new FakeUtilityProcess();
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    reportResult(child);
    expect(child.postMessage).toHaveBeenLastCalledWith({
      type: "conversation-attachment-store.result-ack",
      operationId: operationId(child),
    });
    const settled = vi.fn();
    void running.result.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    child.emit("exit", 0);
    await expect(running.result).resolves.toBeUndefined();
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("fails a malformed or duplicate event and confirms the killed exit", async () => {
    const child = new FakeUtilityProcess();
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    child.emit("message", { invalid: true });
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1);
    await expect(running.result).rejects.toThrow("invalid result");
    await expect(running.stopped).resolves.toBeUndefined();

    const duplicate = new FakeUtilityProcess();
    const duplicateRunner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(duplicate),
    });
    const duplicateRunning = duplicateRunner(operation);
    duplicate.emit("spawn");
    reportResult(duplicate);
    reportResult(duplicate);
    expect(duplicate.kill).toHaveBeenCalledOnce();
    duplicate.emit("exit", 1);
    await expect(duplicateRunning.result).rejects.toThrow("invalid result");
  });

  it("reports spawn failure without claiming a process was started", async () => {
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => { throw new Error("spawn failed"); },
    });
    const running = runner(operation);
    await expect(running.result).rejects.toThrow("spawn failed");
    await expect(running.stopped).resolves.toBeUndefined();
    await expect(running.ready).resolves.toBe(false);
  });

  it.each([
    [1, undefined],
    [0, "SIGKILL"],
  ])("rejects a success frame followed by abnormal exit (%s, %s)", async (
    code,
    signal,
  ) => {
    const child = new FakeUtilityProcess();
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    reportResult(child);
    child.emit("exit", code, signal);
    await expect(running.result).rejects.toThrow("stopped unexpectedly");
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("rejects exit before a terminal result without sending an acknowledgement", async () => {
    const child = new FakeUtilityProcess();
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    child.emit("exit", 0);

    await expect(running.result).rejects.toThrow("stopped unexpectedly");
    expect(child.postMessage).toHaveBeenCalledTimes(1);
  });

  it("kills a worker when the exact result acknowledgement cannot be delivered", async () => {
    const child = new FakeUtilityProcess();
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    child.postMessage.mockImplementationOnce(() => {
      throw new Error("ack channel closed");
    });
    reportResult(child);

    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1);
    await expect(running.result).rejects.toThrow("acknowledgement");
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("rejects a terminal result for a different operation", async () => {
    const child = new FakeUtilityProcess();
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("spawn");
    child.emit("message", {
      type: "conversation-attachment-store.result",
      operationId: crypto.randomUUID(),
      ok: true,
    });

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenCalledTimes(1);
    child.emit("exit", 1);
    await expect(running.result).rejects.toThrow("invalid result");
  });

  it("rejects a result received before utility startup", async () => {
    const child = new FakeUtilityProcess();
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation);
    child.emit("message", {
      type: "conversation-attachment-store.result",
      operationId: crypto.randomUUID(),
      ok: true,
    });
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1);
    await expect(running.result).rejects.toThrow("before startup");
  });

  it("bounds timeout shutdown and distinguishes confirmed from unconfirmed exit", async () => {
    vi.useFakeTimers();
    try {
      const confirmed = new FakeUtilityProcess();
      const runner = createConversationAttachmentStoreUtilityRunner({
        spawn: () => utility(confirmed),
        timeoutMs: 25,
        killGraceMs: 10,
      });
      const running = runner(operation);
      void running.result.catch(() => undefined);
      confirmed.emit("spawn");
      await vi.advanceTimersByTimeAsync(25);
      expect(confirmed.kill).toHaveBeenCalledOnce();
      confirmed.emit("exit", 1);
      await expect(running.result).rejects.toThrow("timed out");
      await expect(running.stopped).resolves.toBeUndefined();

      const stuck = new FakeUtilityProcess();
      const stuckRunner = createConversationAttachmentStoreUtilityRunner({
        spawn: () => utility(stuck),
        timeoutMs: 25,
        killGraceMs: 10,
      });
      const stuckRunning = stuckRunner(operation);
      void stuckRunning.result.catch(() => undefined);
      void stuckRunning.stopped.catch(() => undefined);
      stuck.emit("spawn");
      await vi.advanceTimersByTimeAsync(35);
      await expect(stuckRunning.result).rejects.toThrow("timed out");
      await expect(stuckRunning.stopped).rejects.toThrow("unconfirmed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels on abort and waits for the exact exit", async () => {
    const child = new FakeUtilityProcess();
    const controller = new AbortController();
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => utility(child),
    });
    const running = runner(operation, controller.signal);
    child.emit("spawn");
    controller.abort(new Error("cancelled by test"));
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1);
    await expect(running.result).rejects.toThrow("cancelled by test");
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("bounds active utilities and queued operations", async () => {
    const children: FakeUtilityProcess[] = [];
    const runner = createConversationAttachmentStoreUtilityRunner({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        return utility(child);
      },
      maxActiveOperations: 2,
      maxPendingOperations: 1,
    });
    const first = runner(operation);
    const second = runner({ ...operation, name: crypto.randomUUID() });
    const queued = runner({ ...operation, name: crypto.randomUUID() });
    const overflow = runner({ ...operation, name: crypto.randomUUID() });
    void first.result.catch(() => undefined);
    void second.result.catch(() => undefined);

    expect(children).toHaveLength(2);
    await expect(overflow.result).rejects.toThrow("bounded capacity");
    await expect(overflow.stopped).resolves.toBeUndefined();

    children[0].emit("spawn");
    reportResult(children[0]);
    children[0].emit("exit", 0);
    await expect(first.result).resolves.toBeUndefined();
    await vi.waitFor(() => expect(children).toHaveLength(3));

    for (const child of children.slice(1)) {
      child.emit("spawn");
      reportResult(child);
      child.emit("exit", 0);
    }
    await expect(second.result).resolves.toBeUndefined();
    await expect(queued.result).resolves.toBeUndefined();
  });

  it("cancels queued work without spawning it", async () => {
    const children: FakeUtilityProcess[] = [];
    const runner = createConversationAttachmentStoreUtilityRunner({
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
    const queued = runner(
      { ...operation, name: crypto.randomUUID() },
      controller.signal,
    );
    controller.abort(new Error("queued cancellation"));

    await expect(queued.result).rejects.toThrow("queued cancellation");
    await expect(queued.stopped).resolves.toBeUndefined();
    expect(children).toHaveLength(1);

    children[0].emit("spawn");
    reportResult(children[0]);
    children[0].emit("exit", 0);
    await expect(active.result).resolves.toBeUndefined();
    expect(children).toHaveLength(1);
  });

  it("permanently poisons queued and future work after unconfirmed exit", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const runner = createConversationAttachmentStoreUtilityRunner({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          return utility(child);
        },
        maxActiveOperations: 1,
        maxPendingOperations: 2,
        killGraceMs: 10,
      });
      const controller = new AbortController();
      const active = runner(operation, controller.signal);
      const queued = runner({ ...operation, name: crypto.randomUUID() });
      const activeResult = expect(active.result).rejects.toThrow("cancelled");
      const activeStopped = expect(active.stopped).rejects.toThrow("unconfirmed");
      const queuedResult = expect(queued.result).rejects.toThrow("unconfirmed");
      const queuedStopped = expect(queued.stopped).rejects.toThrow("unconfirmed");
      children[0].emit("spawn");
      controller.abort(new Error("cancelled by poison test"));
      await vi.advanceTimersByTimeAsync(10);

      await activeResult;
      await activeStopped;
      await queuedResult;
      await queuedStopped;
      const future = runner({ ...operation, name: crypto.randomUUID() });
      await expect(future.result).rejects.toThrow("unconfirmed");
      await expect(future.stopped).rejects.toThrow("unconfirmed");
      await expect(future.ready).resolves.toBe(false);
      expect(children).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects active sibling success after another helper exit is unconfirmed", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const runner = createConversationAttachmentStoreUtilityRunner({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          return utility(child);
        },
        maxActiveOperations: 2,
        maxPendingOperations: 1,
        killGraceMs: 10,
      });
      const controller = new AbortController();
      const failed = runner(operation, controller.signal);
      const sibling = runner({ ...operation, name: crypto.randomUUID() });
      const failedResult = expect(failed.result).rejects.toThrow("cancelled");
      const failedStopped = expect(failed.stopped).rejects.toThrow("unconfirmed");
      const siblingResult = expect(sibling.result).rejects.toThrow("unconfirmed");
      children.forEach((child) => child.emit("spawn"));
      reportResult(children[1]);
      controller.abort(new Error("cancelled active helper"));
      await vi.advanceTimersByTimeAsync(10);

      expect(children[1].kill).toHaveBeenCalledOnce();
      children[1].emit("exit", 0);
      await failedResult;
      await failedStopped;
      await siblingResult;
      await expect(sibling.stopped).resolves.toBeUndefined();
      const future = runner({ ...operation, name: crypto.randomUUID() });
      await expect(future.result).rejects.toThrow("unconfirmed");
      await expect(future.stopped).rejects.toThrow("unconfirmed");
      expect(children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
