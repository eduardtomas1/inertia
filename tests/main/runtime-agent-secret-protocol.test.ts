// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseRuntimeWorkerCommand, parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";

describe("agent secret process protocol", () => {
  const transportId = randomUUID();
  const deliver = {
    type: "runtime.agent-secret-deliver",
    transportId,
    conversationId: randomUUID(),
    requestId: randomUUID(),
    secret: "tskey-auth-123",
    vaulted: true,
  };

  it("accepts an exact delivery command from main", () => {
    expect(parseRuntimeWorkerCommand(deliver)).toEqual(deliver);
  });

  it.each([
    ["an untrimmed secret", { ...deliver, secret: " tskey-auth-123" }],
    ["a short secret", { ...deliver, secret: "abc" }],
    ["a multi-line secret", { ...deliver, secret: "tskey\nauth" }],
    ["a non-uuid transport", { ...deliver, transportId: "transport" }],
    ["a missing vault flag", { ...deliver, vaulted: undefined }],
    ["an extra field", { ...deliver, file: "/tmp/secret" }],
  ])("rejects a delivery with %s", (_label, command) => {
    expect(parseRuntimeWorkerCommand(command)).toBeNull();
  });

  it("accepts delivered and rejected events with bounded fields", () => {
    const delivered = { type: "runtime.agent-secret-delivered", transportId, expiresAt: "2026-10-30T10:00:00.000Z", storage: "memory" };
    expect(parseRuntimeWorkerEvent(delivered)).toEqual(delivered);
    for (const reason of ["not-pending", "ended", "file-failed", "limit"]) {
      const rejected = { type: "runtime.agent-secret-rejected", transportId, reason };
      expect(parseRuntimeWorkerEvent(rejected)).toEqual(rejected);
    }
    expect(parseRuntimeWorkerEvent({ ...delivered, storage: "disk" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ ...delivered, expiresAt: "tomorrow" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ ...delivered, secret: "tskey-auth-123" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.agent-secret-rejected", transportId, reason: "Value tskey-auth-123 failed" })).toBeNull();
  });
});
