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
    secret: "fake-token-123",
    vaulted: true,
  };

  it("accepts an exact delivery command from main", () => {
    expect(parseRuntimeWorkerCommand(deliver)).toEqual(deliver);
  });

  it.each([
    ["an untrimmed secret", { ...deliver, secret: " fake-token-123" }],
    ["a short secret", { ...deliver, secret: "abc" }],
    ["a multi-line secret", { ...deliver, secret: "fixture\nauth" }],
    ["a non-uuid request", { ...deliver, requestId: "request" }],
  ])("passes a delivery with %s through to the runtime, which rejects it instead of stopping", (_label, command) => {
    expect(parseRuntimeWorkerCommand(command)).toEqual(command);
  });

  it.each([
    ["a non-string secret", { ...deliver, secret: 42 }],
    ["an unbounded request id", { ...deliver, requestId: "r".repeat(129) }],
    ["a non-uuid transport", { ...deliver, transportId: "transport" }],
    ["a missing vault flag", { ...deliver, vaulted: undefined }],
    ["an extra field", { ...deliver, file: "/tmp/secret" }],
  ])("rejects a delivery with %s", (_label, command) => {
    expect(parseRuntimeWorkerCommand(command)).toBeNull();
  });

  it("accepts delivered and rejected events with bounded fields", () => {
    const delivered = { type: "runtime.agent-secret-delivered", transportId, expiresAt: "2026-10-30T10:00:00.000Z", storage: "memory" };
    expect(parseRuntimeWorkerEvent(delivered)).toEqual(delivered);
    for (const reason of ["not-pending", "ended", "file-failed", "limit", "invalid"]) {
      const rejected = { type: "runtime.agent-secret-rejected", transportId, reason };
      expect(parseRuntimeWorkerEvent(rejected)).toEqual(rejected);
    }
    expect(parseRuntimeWorkerEvent({ ...delivered, storage: "disk" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ ...delivered, expiresAt: "tomorrow" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ ...delivered, secret: "fake-token-123" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.agent-secret-rejected", transportId, reason: "Value fake-token-123 failed" })).toBeNull();
  });

  it("accepts bounded reconcile commands and events that carry only request ids", () => {
    const requestIds = [randomUUID(), randomUUID()];
    const reconcile = { type: "runtime.agent-secret-reconcile", transportId, requestIds };
    expect(parseRuntimeWorkerCommand(reconcile)).toEqual(reconcile);
    const reconciled = { type: "runtime.agent-secret-reconciled", transportId, orphaned: [requestIds[0]] };
    expect(parseRuntimeWorkerEvent(reconciled)).toEqual(reconciled);
    expect(parseRuntimeWorkerEvent({ ...reconciled, orphaned: [] })).toEqual({ ...reconciled, orphaned: [] });
    const tooMany = Array.from({ length: 257 }, () => randomUUID());
    for (const invalid of [
      { ...reconcile, requestIds: [] },
      { ...reconcile, requestIds: tooMany },
      { ...reconcile, requestIds: [requestIds[0], requestIds[0]] },
      { ...reconcile, requestIds: ["secret:agent-secret:x"] },
      { ...reconcile, secret: "fake-token-123" },
    ]) expect(parseRuntimeWorkerCommand(invalid)).toBeNull();
    for (const invalid of [
      { ...reconciled, orphaned: tooMany },
      { ...reconciled, orphaned: ["fake-token-123"] },
      { ...reconciled, orphaned: [requestIds[0], requestIds[0]] },
      { ...reconciled, kept: requestIds },
    ]) expect(parseRuntimeWorkerEvent(invalid)).toBeNull();
  });
});

