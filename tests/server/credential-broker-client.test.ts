import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import {
  RuntimeCredentialBrokerClient,
  RuntimeCredentialBrokerError,
} from "../../src/server/runtime/backends/credential-broker-client";

const reference = `secret:backend:${"a".repeat(64)}`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("RuntimeCredentialBrokerClient", () => {
  it("correlates successful requests without placing secrets in errors or references", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeCredentialBrokerClient({
      post: (event) => posted.push(event),
    });
    const resolved = client.resolve(reference);
    const request = posted[0];
    expect(request).toMatchObject({
      type: "runtime.credential-request",
      operation: "resolve",
      secretReference: reference,
    });
    if (request?.type !== "runtime.credential-request") throw new Error("missing request");

    expect(client.handle({
      type: "runtime.credential-result",
      requestId: request.requestId,
      operation: "resolve",
      ok: true,
      secret: "materialized-secret",
    })).toBe(true);
    expect(await resolved).toBe("materialized-secret");
    expect(client.pendingCount()).toBe(0);
  });

  it("ignores mismatched, duplicate, and stale results", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeCredentialBrokerClient({
      post: (event) => posted.push(event),
    });
    const status = client.has(reference);
    const request = posted[0];
    if (request?.type !== "runtime.credential-request") throw new Error("missing request");

    expect(client.handle({
      type: "runtime.credential-result",
      requestId: request.requestId,
      operation: "clear",
      ok: true,
      removed: true,
    })).toBe(false);
    expect(client.handle({
      type: "runtime.credential-result",
      requestId: request.requestId,
      operation: "status",
      ok: true,
      hasSecret: true,
      credentialGeneration: "generation:test",
    })).toBe(true);
    expect(client.handle({
      type: "runtime.credential-result",
      requestId: request.requestId,
      operation: "status",
      ok: true,
      hasSecret: false,
      credentialGeneration: null,
    })).toBe(false);
    expect(await status).toBe(true);
  });

  it("returns non-secret credential generation and supports tombstone pruning", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeCredentialBrokerClient({
      post: (event) => posted.push(event),
    });
    const status = client.status(reference);
    const statusRequest = posted.at(-1);
    if (statusRequest?.type !== "runtime.credential-request") throw new Error("missing status");
    client.handle({
      type: "runtime.credential-result",
      requestId: statusRequest.requestId,
      operation: "status",
      ok: true,
      hasSecret: false,
      credentialGeneration: "generation:tombstone",
    });
    await expect(status).resolves.toEqual({
      hasSecret: false,
      credentialGeneration: "generation:tombstone",
    });

    const forgotten = client.forget(reference);
    const forgetRequest = posted.at(-1);
    if (forgetRequest?.type !== "runtime.credential-request") throw new Error("missing forget");
    expect(forgetRequest.operation).toBe("forget");
    client.handle({
      type: "runtime.credential-result",
      requestId: forgetRequest.requestId,
      operation: "forget",
      ok: true,
      removed: true,
    });
    await expect(forgotten).resolves.toBe(true);
  });

  it("times out and cancels pending requests deterministically", async () => {
    const client = new RuntimeCredentialBrokerClient({
      post: () => undefined,
      timeoutMs: 25,
    });
    const timedOut = client.resolve(reference);
    const timeoutExpectation = expect(timedOut).rejects.toEqual(
      new RuntimeCredentialBrokerError(
        "timeout",
        "Secure credential storage did not respond in time.",
      ),
    );
    await vi.advanceTimersByTimeAsync(25);
    await timeoutExpectation;

    const controller = new AbortController();
    const cancelled = client.has(reference, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects invalid references and closes all pending requests", async () => {
    const client = new RuntimeCredentialBrokerClient({ post: () => undefined });
    await expect(client.resolve("not-a-secret-reference")).rejects.toMatchObject({
      code: "invalid-reference",
    });
    const pending = client.clear(reference);
    client.close();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await expect(client.has(reference)).rejects.toMatchObject({ code: "closed" });
  });

  it("maps broker failures to fixed public messages", async () => {
    const posted: RuntimeWorkerEvent[] = [];
    const client = new RuntimeCredentialBrokerClient({
      post: (event) => posted.push(event),
    });
    const resolved = client.resolve(reference);
    const request = posted[0];
    if (request?.type !== "runtime.credential-request") throw new Error("missing request");
    client.handle({
      type: "runtime.credential-result",
      requestId: request.requestId,
      operation: "resolve",
      ok: false,
      code: "unavailable",
      message: "provider-secret-should-not-surface",
    });
    await expect(resolved).rejects.toEqual(new RuntimeCredentialBrokerError(
      "unavailable",
      "Secure credential storage is unavailable.",
    ));
  });
});
