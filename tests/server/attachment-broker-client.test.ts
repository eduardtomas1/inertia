import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkerEvent } from "../../src/main/runtime-process-protocol";
import { RuntimeAttachmentBrokerClient } from "../../src/server/runtime/attachments/attachment-broker-client";

const attachmentId = "11111111-1111-4111-8111-111111111111";
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
    const resolved = client.resolve(attachmentId);
    const request = posted[0];
    expect(request).toMatchObject({
      type: "runtime.attachment-request",
      attachmentId,
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
    const missing = client.resolve(attachmentId);
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

    const unavailable = client.resolve(attachmentId);
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

  it("times out, cancels, and closes pending requests", async () => {
    const client = new RuntimeAttachmentBrokerClient(() => undefined, 25);
    const timedOut = client.resolve(attachmentId);
    const timeoutExpectation = expect(timedOut).rejects.toThrow(
      /could not be verified/u,
    );
    await vi.advanceTimersByTimeAsync(25);
    await timeoutExpectation;

    const controller = new AbortController();
    const cancelled = client.resolve(attachmentId, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow(/could not be verified/u);

    const pending = client.resolve(attachmentId);
    client.close();
    await expect(pending).rejects.toThrow(/could not be verified/u);
    await expect(client.resolve(attachmentId)).rejects.toThrow(
      /could not be verified/u,
    );
    expect(client.pendingCount()).toBe(0);
  });
});
