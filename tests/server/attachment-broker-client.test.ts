import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { RuntimeAttachmentBrokerClient } from "../../src/server/runtime/attachments/attachment-broker-client";

const attachmentId = "11111111-1111-4111-8111-111111111111";
const handoffId = "22222222-2222-4222-8222-222222222222";
const attachment = {
  id: attachmentId,
  name: "preview.png",
  path: resolve("/tmp", `${attachmentId}.png`),
  mimeType: "image/png" as const,
  size: 8,
  digest: "a".repeat(64),
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("RuntimeAttachmentBrokerClient", () => {
  it("correlates one opaque capability without sending a renderer path", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAttachmentBrokerClient(
      (event) => posted.push(event),
    );
    const resolved = client.resolve(attachmentId, handoffId);
    const request = posted[0];
    expect(request).toMatchObject({
      type: "runtime.attachment-request",
      attachmentId,
      handoffId,
    });
    expect(JSON.stringify(request)).not.toContain(attachment.path);
    if (request?.type !== "runtime.attachment-request") throw new Error("missing request");

    expect(client.handle({
      type: "runtime.attachment-result",
      requestId: request.requestId,
      ok: true,
      attachment,
    })).toBe(true);
    await expect(resolved).resolves.toEqual(attachment);
    expect(client.pendingCount()).toBe(0);
  });

  it("maps missing capabilities to null and rejects unavailable storage", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAttachmentBrokerClient(
      (event) => posted.push(event),
    );
    const missing = client.resolve(attachmentId, handoffId);
    const missingRequest = posted.at(-1);
    if (missingRequest?.type !== "runtime.attachment-request") throw new Error("missing request");
    client.handle({
      type: "runtime.attachment-result",
      requestId: missingRequest.requestId,
      ok: false,
      code: "not-found",
      message: "missing",
    });
    await expect(missing).resolves.toBeNull();

    const unavailable = client.resolve(attachmentId, handoffId);
    const unavailableRequest = posted.at(-1);
    if (unavailableRequest?.type !== "runtime.attachment-request") throw new Error("missing request");
    client.handle({
      type: "runtime.attachment-result",
      requestId: unavailableRequest.requestId,
      ok: false,
      code: "unavailable",
      message: "private detail",
    });
    await expect(unavailable).rejects.toThrow(/could not be verified/u);
  });

  it("releases one opaque capability without sending attachment metadata", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAttachmentBrokerClient(
      (event) => posted.push(event),
    );
    const released = client.release(attachmentId);
    const request = posted[0];
    expect(request).toMatchObject({
      type: "runtime.attachment-release-request",
      attachmentId,
    });
    expect(JSON.stringify(request)).not.toContain(attachment.path);
    if (request?.type !== "runtime.attachment-release-request") {
      throw new Error("missing release request");
    }

    expect(client.handleRelease({
      type: "runtime.attachment-release-result",
      requestId: request.requestId,
      ok: true,
      released: true,
    })).toBe(true);
    await expect(released).resolves.toBe(true);
    expect(client.pendingCount()).toBe(0);
  });

  it("uses an explicit cleanup request for restart recovery", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAttachmentBrokerClient(
      (event) => posted.push(event),
    );
    const cleaned = client.cleanup(attachmentId);
    const request = posted[0];
    expect(request).toMatchObject({
      type: "runtime.attachment-cleanup-request",
      attachmentId,
    });
    if (request?.type !== "runtime.attachment-cleanup-request") {
      throw new Error("missing cleanup request");
    }

    client.handleRelease({
      type: "runtime.attachment-release-result",
      requestId: request.requestId,
      ok: true,
      released: true,
    });
    await expect(cleaned).resolves.toBe(true);
  });

  it("relinquishes ownership without requesting file deletion", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAttachmentBrokerClient(
      (event) => posted.push(event),
    );
    const relinquished = client.relinquish(attachmentId);
    const request = posted[0];
    expect(request).toMatchObject({
      type: "runtime.attachment-relinquish-request",
      attachmentId,
    });
    expect(JSON.stringify(request)).not.toContain(attachment.path);
    if (request?.type !== "runtime.attachment-relinquish-request") {
      throw new Error("missing relinquish request");
    }

    expect(client.handleRelinquish({
      type: "runtime.attachment-relinquish-result",
      requestId: request.requestId,
      ok: true,
      relinquished: true,
    })).toBe(true);
    await expect(relinquished).resolves.toBe(true);
    expect(client.pendingCount()).toBe(0);
  });

  it("times out, cancels, and closes pending requests", async () => {
    const client = new RuntimeAttachmentBrokerClient(() => undefined, 25);
    const timedOut = client.resolve(attachmentId, handoffId);
    const timeoutExpectation = expect(timedOut).rejects.toThrow(
      /could not be verified/u,
    );
    await vi.advanceTimersByTimeAsync(25);
    await timeoutExpectation;

    const controller = new AbortController();
    const cancelled = client.resolve(attachmentId, handoffId, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow(/could not be verified/u);

    const pending = client.resolve(attachmentId, handoffId);
    const pendingRelease = client.release(attachmentId);
    const pendingRelinquish = client.relinquish(attachmentId);
    client.close();
    await expect(pending).rejects.toThrow(/could not be verified/u);
    await expect(pendingRelease).rejects.toThrow(/could not be verified/u);
    await expect(pendingRelinquish).rejects.toThrow(/could not be verified/u);
    await expect(client.resolve(attachmentId, handoffId)).rejects.toThrow(
      /could not be verified/u,
    );
    await expect(client.release(attachmentId)).rejects.toThrow(
      /could not be verified/u,
    );
    await expect(client.relinquish(attachmentId)).rejects.toThrow(
      /could not be verified/u,
    );
    expect(client.pendingCount()).toBe(0);
  });

  it("relinquishes exactly once when a timed-out resolve later succeeds", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAttachmentBrokerClient(
      (event) => posted.push(event),
      25,
    );
    const resolved = client.resolve(attachmentId, handoffId);
    const resolveRequest = posted[0];
    if (resolveRequest?.type !== "runtime.attachment-request") {
      throw new Error("missing resolve request");
    }
    const rejection = expect(resolved).rejects.toThrow(/could not be verified/u);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(client.pendingCount()).toBe(1);

    expect(client.handle({
      type: "runtime.attachment-result",
      requestId: resolveRequest.requestId,
      ok: true,
      attachment,
    })).toBe(true);
    const relinquishRequest = posted.at(-1);
    expect(relinquishRequest).toMatchObject({
      type: "runtime.attachment-relinquish-request",
      attachmentId,
    });
    if (relinquishRequest?.type !== "runtime.attachment-relinquish-request") {
      throw new Error("missing late-success relinquish");
    }
    expect(client.handle({
      type: "runtime.attachment-result",
      requestId: resolveRequest.requestId,
      ok: true,
      attachment,
    })).toBe(false);
    client.handleRelinquish({
      type: "runtime.attachment-relinquish-result",
      requestId: relinquishRequest.requestId,
      ok: true,
      relinquished: true,
    });
    expect(client.pendingCount()).toBe(0);
  });

  it("clears a timed-out resolve tombstone on late failure without relinquishing", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAttachmentBrokerClient(
      (event) => posted.push(event),
      25,
    );
    const resolved = client.resolve(attachmentId, handoffId);
    const resolveRequest = posted[0];
    if (resolveRequest?.type !== "runtime.attachment-request") {
      throw new Error("missing resolve request");
    }
    const rejection = expect(resolved).rejects.toThrow(/could not be verified/u);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(client.handle({
      type: "runtime.attachment-result",
      requestId: resolveRequest.requestId,
      ok: false,
      code: "unavailable",
      message: "main request timed out",
    })).toBe(true);
    expect(posted).toHaveLength(1);
    expect(client.pendingCount()).toBe(0);
  });

  it("fails closed before posting beyond the bounded resolve correlation set", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeAttachmentBrokerClient(
      (event) => posted.push(event),
    );
    const pending = Array.from({ length: 512 }, () =>
      client.resolve(attachmentId, handoffId).catch(() => null));

    await expect(client.resolve(attachmentId, handoffId)).rejects.toThrow(
      /could not be verified/u,
    );
    expect(posted).toHaveLength(512);
    expect(client.pendingCount()).toBe(512);

    client.close();
    await Promise.all(pending);
    expect(client.pendingCount()).toBe(0);
  });
});
