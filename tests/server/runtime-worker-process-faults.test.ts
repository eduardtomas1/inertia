import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeDiagnostics, runtimeDiagnosticsDirectory } from "../../src/main/runtime-diagnostics";
import { parseRuntimeFailureDiagnosticMessage, runtimeRestartFailureMessage } from "../../src/node/runtime-failure-diagnostic";
import { parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { parseDiagnosticIncident } from "../../src/shared/application-diagnostics";
import {
  installRuntimeWorkerFaultHandlers,
  runtimeOwnedProcessFaultIncidentCode,
} from "../../src/server/runtime-worker-process-faults";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime worker fault handlers", () => {
  it("records an unhandled rejection and keeps the worker running", () => {
    const target = new EventEmitter();
    const recordIncident = vi.fn();
    const requestRestart = vi.fn();
    installRuntimeWorkerFaultHandlers(target, { started: () => true, recordIncident, requestRestart });

    target.emit("unhandledRejection", new Error("PRIVATE provider output"), Promise.resolve());
    target.emit("unhandledRejection", "PRIVATE", Promise.resolve());

    expect(recordIncident.mock.calls).toEqual([
      ["runtime.unhandled-rejection"],
      ["runtime.unhandled-rejection"],
    ]);
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it("treats an unhandled rejection before the runtime starts as fatal", () => {
    const target = new EventEmitter();
    const recordIncident = vi.fn();
    const requestRestart = vi.fn();
    installRuntimeWorkerFaultHandlers(target, { started: () => false, recordIncident, requestRestart });

    target.emit("unhandledRejection", new Error("PRIVATE"), Promise.resolve());

    expect(requestRestart).toHaveBeenCalledOnce();
    expect(recordIncident).not.toHaveBeenCalled();
  });

  it("records an uncaught exception and asks for a runtime restart", () => {
    const target = new EventEmitter();
    const order: string[] = [];
    installRuntimeWorkerFaultHandlers(target, {
      started: () => true,
      recordIncident: (code) => { order.push(code); },
      requestRestart: () => { order.push("restart"); },
    });

    target.emit("uncaughtException", new Error("PRIVATE"));

    expect(order).toEqual(["runtime.uncaught-exception", "restart"]);
  });

  it.each([
    { event: "uncaughtException", started: true },
    { event: "unhandledRejection", started: false },
  ] as const)("exits after the shutdown deadline when a fatal $event shutdown does not finish", ({ event, started }) => {
    vi.useFakeTimers();
    try {
      const target = new EventEmitter();
      const forceExit = vi.fn();
      installRuntimeWorkerFaultHandlers(target, {
        started: () => started,
        recordIncident: vi.fn(),
        requestRestart: vi.fn(),
        forceExit,
        forceExitAfterMs: 1_000,
      });

      target.emit(event, new Error("PRIVATE"), Promise.resolve());
      target.emit(event, new Error("PRIVATE"), Promise.resolve());
      vi.advanceTimersByTime(999);
      expect(forceExit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(forceExit).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(10_000);
      expect(forceExit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not arm a forced exit for a recorded unhandled rejection", () => {
    vi.useFakeTimers();
    try {
      const target = new EventEmitter();
      const forceExit = vi.fn();
      installRuntimeWorkerFaultHandlers(target, {
        started: () => true,
        recordIncident: vi.fn(),
        requestRestart: vi.fn(),
        forceExit,
        forceExitAfterMs: 1_000,
      });
      target.emit("unhandledRejection", new Error("PRIVATE"), Promise.resolve());
      vi.advanceTimersByTime(10_000);
      expect(forceExit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still asks for a restart when recording the incident fails", () => {
    const target = new EventEmitter();
    const requestRestart = vi.fn();
    installRuntimeWorkerFaultHandlers(target, {
      started: () => true,
      recordIncident: () => { throw new Error("diagnostics unavailable"); },
      requestRestart,
    });

    expect(() => target.emit("unhandledRejection", new Error("x"), Promise.resolve())).not.toThrow();
    expect(() => target.emit("uncaughtException", new Error("x"))).not.toThrow();
    expect(requestRestart).toHaveBeenCalledOnce();
  });

  it("carries the uncaught-exception restart reason through the lifecycle protocol and diagnostics", () => {
    const event = { type: "runtime.restart-requested", reason: "uncaught-exception" } as const;
    expect(parseRuntimeWorkerEvent(event)).toEqual(event);
    expect(parseRuntimeWorkerEvent({ ...event, diagnostic: { stage: "linux-stop" } })).toBeNull();
    const message = runtimeRestartFailureMessage(event);
    expect(parseRuntimeFailureDiagnosticMessage(message)).toEqual({
      initiatingCode: "uncaught-exception", shutdownMessage: null,
    });
    const root = mkdtempSync(join(tmpdir(), "inertia-worker-faults-"));
    roots.push(root);
    const directory = runtimeDiagnosticsDirectory(root);
    new RuntimeDiagnostics(directory).recordRestartRequested(event, 4);
    expect(readFileSync(join(directory, "runtime.log"), "utf8")).toContain("\"reason\":\"uncaught-exception\"");
  });

  it.each([
    ["admission-rejected", "runtime.process-start-rejected"],
    ["quarantined", "runtime.process-quarantined"],
    ["root-descendant", "runtime.root-process-running"],
  ] as const)("records an owned-process %s fault as %s", (kind, code) => {
    expect(runtimeOwnedProcessFaultIncidentCode(kind)).toBe(code);
  });

  it.each([
    "runtime.unhandled-rejection",
    "runtime.uncaught-exception",
    "runtime.process-start-rejected",
    "runtime.process-quarantined",
    "runtime.root-process-running",
  ])(
    "accepts the reviewed %s incident code",
    (code) => {
      expect(parseDiagnosticIncident({
        schemaVersion: 1,
        id: "6f1c3b8e-6a55-4a8e-9d6c-0b1f0a1e2d3c",
        correlationId: "6f1c3b8e-6a55-4a8e-9d6c-0b1f0a1e2d3c",
        code,
        outcome: "unknown",
        at: "2026-10-27T00:00:00.000Z",
        runtimeGeneration: "41000000-0000-4000-8000-000000000041:1",
        context: {},
        metadata: {},
      })?.code).toBe(code);
    },
  );
});
