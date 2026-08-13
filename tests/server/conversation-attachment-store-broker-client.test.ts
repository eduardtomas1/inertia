import { describe, expect, it, vi } from "vitest";

import type { RuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { RuntimeConversationAttachmentStoreBrokerClient } from "../../src/server/runtime/attachments/conversation-attachment-store-broker-client";

const operation = {
  operation: "remove" as const,
  root: "/private/conversation-attachments",
  rootDev: "1",
  rootIno: "2",
  rootUid: "501",
  name: "11111111-1111-4111-8111-111111111111",
};

describe("runtime conversation attachment store broker client", () => {
  it("settles only after main confirms the utility process stopped", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeConversationAttachmentStoreBrokerClient(
      (event) => posted.push(event),
    );
    const running = client.runner(operation);
    const request = posted[0];
    expect(request?.type).toBe("runtime.conversation-attachment-store-request");
    if (request?.type !== "runtime.conversation-attachment-store-request") {
      throw new Error("The store request was not posted.");
    }

    expect(client.handle({
      type: "runtime.conversation-attachment-store-result",
      requestId: request.requestId,
      ok: true,
      shutdownConfirmed: true,
      encodedReceipt: null,
    })).toBe(true);
    await expect(running.result).resolves.toBeUndefined();
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("cancels on close without inventing a stopped receipt", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeConversationAttachmentStoreBrokerClient(
      (event) => posted.push(event),
    );
    const running = client.runner(operation);
    const request = posted[0];
    if (request?.type !== "runtime.conversation-attachment-store-request") {
      throw new Error("The store request was not posted.");
    }
    const stopped = vi.fn();
    void running.stopped.then(stopped);

    client.close();

    await expect(running.result).rejects.toThrow(
      "Conversation attachment storage stopped.",
    );
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    expect(posted.at(-1)).toEqual({
      type: "runtime.conversation-attachment-store-cancel",
      requestId: request.requestId,
    });

    client.handle({
      type: "runtime.conversation-attachment-store-result",
      requestId: request.requestId,
      ok: false,
      shutdownConfirmed: true,
      message: "Conversation attachment storage could not complete the operation.",
    });
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("propagates an unconfirmed utility shutdown", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeConversationAttachmentStoreBrokerClient(
      (event) => posted.push(event),
    );
    const running = client.runner(operation);
    const request = posted[0];
    if (request?.type !== "runtime.conversation-attachment-store-request") {
      throw new Error("The store request was not posted.");
    }

    client.handle({
      type: "runtime.conversation-attachment-store-result",
      requestId: request.requestId,
      ok: false,
      shutdownConfirmed: false,
      message: "Conversation attachment storage shutdown could not be confirmed.",
    });
    await expect(running.result).rejects.toThrow("shutdown could not be confirmed");
    await expect(running.stopped).rejects.toThrow("shutdown could not be confirmed");
  });

  it("settles result and stopped on a correlated unavailable reply", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeConversationAttachmentStoreBrokerClient(
      (event) => posted.push(event),
    );
    const running = client.runner(operation);
    const request = posted[0];
    if (request?.type !== "runtime.conversation-attachment-store-request") {
      throw new Error("The store request was not posted.");
    }

    client.handle({
      type: "runtime.conversation-attachment-store-result",
      requestId: request.requestId,
      ok: false,
      shutdownConfirmed: true,
      message: "Conversation attachment storage could not complete the operation.",
    });

    await expect(running.result).rejects.toThrow("could not complete");
    await expect(running.stopped).resolves.toBeUndefined();
  });

  it("fails closed without throwing when cancellation cannot be posted", async () => {
    let posts = 0;
    const client = new RuntimeConversationAttachmentStoreBrokerClient(() => {
      posts += 1;
      if (posts > 1) throw new Error("runtime IPC closed");
    });
    const running = client.runner(operation);

    expect(() => client.close()).not.toThrow();
    await expect(running.result).rejects.toThrow("storage stopped");
    await expect(running.stopped).rejects.toThrow("shutdown could not be confirmed");
  });
});
