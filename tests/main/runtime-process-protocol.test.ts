import { describe, expect, it } from "vitest";

import {
  isRuntimeWebSocketUrl,
  parseRuntimeWorkerCommand,
  parseRuntimeWorkerEvent,
} from "../../src/main/runtime-process-protocol";

const capabilityUrl = `ws://127.0.0.1:43210/runtime/${"a".repeat(43)}`;

describe("runtime process protocol", () => {
  it("accepts only absolute bounded startup options", () => {
    expect(parseRuntimeWorkerCommand({
      type: "runtime.start",
      options: {
        dataDirectory: "/tmp/inertia-data",
        defaultWorkspacePath: "/tmp/inertia-workspace",
        enableProviders: false,
      },
    })).toEqual({
      type: "runtime.start",
      options: {
        dataDirectory: "/tmp/inertia-data",
        defaultWorkspacePath: "/tmp/inertia-workspace",
        enableProviders: false,
      },
    });
    expect(parseRuntimeWorkerCommand({ type: "runtime.start", options: { dataDirectory: "relative", defaultWorkspacePath: "/tmp/workspace", enableProviders: false } })).toBeNull();
    expect(parseRuntimeWorkerCommand({ type: "runtime.shutdown", unexpected: true })).toBeNull();
  });

  it("accepts only a loopback capability URL with the runtime token shape", () => {
    expect(isRuntimeWebSocketUrl(capabilityUrl)).toBe(true);
    expect(parseRuntimeWorkerEvent({ type: "runtime.ready", websocketUrl: capabilityUrl })).toEqual({ type: "runtime.ready", websocketUrl: capabilityUrl });
    expect(isRuntimeWebSocketUrl(`ws://localhost:43210/runtime/${"a".repeat(43)}`)).toBe(false);
    expect(isRuntimeWebSocketUrl(`ws://127.0.0.1:43210/runtime/${"a".repeat(42)}`)).toBe(false);
    expect(isRuntimeWebSocketUrl(`ws://127.0.0.1:43210/runtime/${"a".repeat(43)}?leak=1`)).toBe(false);
    expect(isRuntimeWebSocketUrl(`wss://127.0.0.1:43210/runtime/${"a".repeat(43)}`)).toBe(false);
  });

  it("rejects malformed and oversized worker diagnostics", () => {
    expect(parseRuntimeWorkerEvent({ type: "runtime.startup-failed", message: "SQLite unavailable" })).toEqual({
      type: "runtime.startup-failed",
      message: "SQLite unavailable",
    });
    expect(parseRuntimeWorkerEvent({ type: "runtime.startup-failed", message: "x".repeat(1001) })).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.stopped", extra: true })).toBeNull();
  });
});
