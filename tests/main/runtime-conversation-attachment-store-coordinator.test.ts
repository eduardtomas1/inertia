import { describe, expect, it, vi } from "vitest";

import { RuntimeConversationAttachmentStoreCoordinator } from "../../src/main/runtime-conversation-attachment-store-coordinator";
import type { RuntimeProcessRecord } from "../../src/main/runtime-supervisor-types";
import { encodeConversationAttachmentStoreOperation } from "../../src/node/conversation-attachment-store-child";
import type { RuntimeConversationAttachmentStoreResult } from "../../src/node/runtime-process-protocol";

const authority = {
  root: "/private/conversation-attachments",
  dev: "1",
  ino: "2",
  uid: "501",
};
const operation = {
  operation: "remove" as const,
  root: authority.root,
  rootDev: authority.dev,
  rootIno: authority.ino,
  rootUid: authority.uid,
  name: "11111111-1111-4111-8111-111111111111",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function peer(): RuntimeProcessRecord {
  return {} as RuntimeProcessRecord;
}

function request(requestId = crypto.randomUUID(), encodedOperation = encodeConversationAttachmentStoreOperation(operation)) {
  return {
    type: "runtime.conversation-attachment-store-request" as const,
    requestId,
    encodedOperation,
  };
}

describe("runtime conversation attachment store coordinator", () => {
  it("rejects malformed and unauthorized operations before spawning", async () => {
    const runner = vi.fn();
    const replies: RuntimeConversationAttachmentStoreResult[] = [];
    const coordinator = new RuntimeConversationAttachmentStoreCoordinator({
      runner: runner as never,
      authority,
      accepts: () => true,
      post: (_record, result) => replies.push(result),
    });
    coordinator.handle(peer(), request(crypto.randomUUID(), "not-json"));
    coordinator.handle(peer(), request(crypto.randomUUID(),
      encodeConversationAttachmentStoreOperation({
        ...operation,
        root: "/private/other",
      })));

    expect(runner).not.toHaveBeenCalled();
    expect(replies).toHaveLength(2);
    expect(replies.every((reply) => !reply.ok)).toBe(true);
    await expect(coordinator.shutdown()).resolves.toBe(true);
  });

  it("rejects a global in-flight request-id collision across peers", async () => {
    const result = deferred<void>();
    const stopped = deferred<void>();
    const runner = vi.fn(() => ({
      result: result.promise,
      stopped: stopped.promise,
      ready: Promise.resolve(false),
    }));
    const replies: RuntimeConversationAttachmentStoreResult[] = [];
    const coordinator = new RuntimeConversationAttachmentStoreCoordinator({
      runner: runner as never,
      authority,
      accepts: () => true,
      post: (_record, reply) => replies.push(reply),
    });
    const requestId = crypto.randomUUID();
    coordinator.handle(peer(), request(requestId));
    coordinator.handle(peer(), request(requestId));

    expect(runner).toHaveBeenCalledOnce();
    expect(replies).toEqual([expect.objectContaining({
      requestId,
      ok: false,
    })]);
    result.resolve();
    stopped.resolve();
    await expect(coordinator.shutdown()).resolves.toBe(true);
  });

  it("cancels only the operation owned by the exact peer", async () => {
    const result = deferred<void>();
    const stopped = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const coordinator = new RuntimeConversationAttachmentStoreCoordinator({
      runner: ((_operation: unknown, signal?: AbortSignal) => {
        observedSignal = signal;
        return {
          result: result.promise,
          stopped: stopped.promise,
          ready: Promise.resolve(false),
        };
      }) as never,
      authority,
      accepts: () => true,
      post: vi.fn(),
    });
    const owner = peer();
    const other = peer();
    const requestId = crypto.randomUUID();
    coordinator.handle(owner, request(requestId));
    coordinator.handle(other, {
      type: "runtime.conversation-attachment-store-cancel",
      requestId,
    });
    expect(observedSignal?.aborted).toBe(false);
    coordinator.handle(owner, {
      type: "runtime.conversation-attachment-store-cancel",
      requestId,
    });
    expect(observedSignal?.aborted).toBe(true);
    result.reject(new Error("cancelled"));
    stopped.resolve();
    await expect(coordinator.shutdown()).resolves.toBe(true);
  });

  it("reports completion only after authoritative stop confirmation", async () => {
    const result = deferred<void>();
    const stopped = deferred<void>();
    const post = vi.fn();
    const coordinator = new RuntimeConversationAttachmentStoreCoordinator({
      runner: (() => ({
        result: result.promise,
        stopped: stopped.promise,
        ready: Promise.resolve(false),
      })) as never,
      authority,
      accepts: () => true,
      post,
    });
    coordinator.handle(peer(), request());
    result.resolve();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    stopped.resolve();
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true, shutdownConfirmed: true }),
    ));
    await expect(coordinator.shutdown()).resolves.toBe(true);
  });

  it("returns false from shutdown when utility exit is unconfirmed", async () => {
    const result = deferred<void>();
    const stopped = deferred<void>();
    const post = vi.fn();
    const coordinator = new RuntimeConversationAttachmentStoreCoordinator({
      runner: (() => ({
        result: result.promise,
        stopped: stopped.promise,
        ready: Promise.resolve(false),
      })) as never,
      authority,
      accepts: () => true,
      post,
    });
    coordinator.handle(peer(), request());
    result.reject(new Error("failed"));
    stopped.reject(new Error("unconfirmed"));

    await expect(coordinator.shutdown()).resolves.toBe(false);
    expect(post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: false, shutdownConfirmed: false }),
    );
  });
});
