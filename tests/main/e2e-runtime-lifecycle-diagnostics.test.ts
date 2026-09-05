import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { attachRuntimeLifecycleFailureDiagnostic } from
  "../e2e/support/runtime-lifecycle-diagnostics";

const diagnostic = {
  schemaVersion: 1, capturedAt: "2030-01-01T00:00:00.000Z",
  runtimeStartedAt: null, runtimeUptimeMs: 0, runtimeGenerationHash: "a".repeat(12),
  buildMetadata: null, systemBootRelationship: "current", startupBlockerCodes: [],
  quarantineReason: null, cleanupProofMethod: "current-generation-lease",
  ownedResources: { providerRuns: 0, turns: 0, terminals: 0, workspaceRuns: 0,
    interactions: 0, maintenanceOperations: 0 },
  activeProviders: [], providerMaintenance: [], updateHandoffPhase: null,
  unresolvedTurnCount: 0, unresolvedInteractionCount: 0, actionableState: "safe-and-ready",
  windowsCleanupFailures: [{ phase: "taskkill-exit", scope: "pid", force: true,
    elapsedMs: 34, exitCode: 128 }],
};

describe("native failure lifecycle attachment", () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("attaches only the validated projection (invalid=%s)", async (invalid) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("Missing test address.");
    const attach = vi.fn(async () => undefined);
    let receivedCommands = 0;
    server.on("connection", (socket) => {
      socket.on("message", () => receivedCommands++);
      socket.send(JSON.stringify({ type: "server.welcome", snapshot: {
        conversations: [{ prompt: "PRIVATE-CONVERSATION" }],
        lifecycleDiagnostics: invalid ? { ...diagnostic, secret: "PRIVATE-DIAGNOSTIC" } : diagnostic,
      } }));
    });
    try {
      await attachRuntimeLifecycleFailureDiagnostic({ attach }, async () =>
        `ws://127.0.0.1:${address.port}/PRIVATE-TOKEN`);
      expect(attach).toHaveBeenCalledWith("runtime-lifecycle-diagnostic", {
        contentType: "application/json",
        body: JSON.stringify({ outcome: "captured", value: invalid ? null : diagnostic }, null, 2),
      });
      expect(JSON.stringify(attach.mock.calls)).not.toContain("PRIVATE");
      expect(receivedCommands).toBe(0);
    } finally {
      server.clients.forEach((socket) => socket.terminate());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds an unavailable main-process snapshot without exposing its error", async () => {
    vi.useFakeTimers();
    const attach = vi.fn(async () => undefined);
    const pending = attachRuntimeLifecycleFailureDiagnostic({ attach },
      () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(attach).toHaveBeenCalledWith("runtime-lifecycle-diagnostic", {
      contentType: "application/json", body: JSON.stringify({ outcome: "timed-out" }, null, 2),
    });
  });
});
