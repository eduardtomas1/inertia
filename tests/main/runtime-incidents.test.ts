import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { RuntimeIncidentObserver } from "../../src/main/runtime-incident-observer";
import { windowsRuntimeJobName } from "../../src/main/windows-runtime-job";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

describe("runtime incidents", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("rejects malformed/stale generation messages without terminating the current runtime", () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "inertia-runtime-incidents-"));
    const child = new EventEmitter() as EventEmitter & { pid: number; postMessage: (value: RuntimeWorkerCommand) => void; kill: () => boolean };
    const commands: RuntimeWorkerCommand[] = [];
    child.pid = 10000; child.postMessage = (command) => commands.push(command); child.kill = vi.fn(() => true);
    const onIncident = vi.fn();
    const supervisor = new RuntimeSupervisor({
      systemBootId: `test:${randomUUID()}`,
      spawn: () => child as never, workerOptions: { dataDirectory: directory, defaultWorkspacePath: directory, enableProviders: false },
      onIncident, forceKill: () => true, recoverOwnedProcesses: () => true,
      // Model the same exact-generation containment as the supervisor fixtures.
      // A missing Windows Job must reject startup, even in this fake child.
      armProcessContainment: (generation) => process.platform === "win32"
        ? { kind: "windows-job-v1", name: windowsRuntimeJobName(generation) }
        : null,
    });
    try {
      supervisor.start(); child.emit("spawn");
      expect(supervisor.snapshot().lastError).toBeNull();
      const start = commands.find((command) => command.type === "runtime.start");
      if (start?.type !== "runtime.start") throw new Error("Missing runtime start");
      const incident = { schemaVersion: 1, id: randomUUID(), correlationId: randomUUID(), code: "turn.failed",
        at: new Date().toISOString(), outcome: "failed", context: {}, metadata: {}, runtimeGeneration: start.options.runtimeGenerationId };
      child.emit("message", { type: "runtime.incident", incident: { ...incident, rawOutput: "SECRET" } });
      child.emit("message", { type: "runtime.incident", incident: { ...incident, runtimeGeneration: `${randomUUID()}:1` } });
      expect(onIncident).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
      child.emit("message", { type: "runtime.incident", incident });
      expect(onIncident).toHaveBeenCalledExactlyOnceWith(incident);
      child.emit("message", { type: "runtime.ready", websocketUrl: `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}` });
      expect(supervisor.snapshot().phase).toBe("ready");
    } finally { vi.clearAllTimers(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("distinguishes expected exits from failures and correlates one recovery episode across generations", () => {
    const sink = vi.fn(); const observer = new RuntimeIncidentObserver(sink);
    const first = `${randomUUID()}:1`; const second = `${randomUUID()}:2`;
    observer.state("ready", first); observer.exited(first, true, false, 0);
    expect(sink).not.toHaveBeenCalled();
    observer.exited(first, true, true, 1); observer.state("restarting", first); observer.state("restarting", first);
    expect(sink).toHaveBeenCalledTimes(2);
    const warning = sink.mock.calls[1]![0];
    observer.state("starting", second); observer.state("ready", second);
    expect(sink.mock.calls[2]![0]).toMatchObject({ id: warning.id, runtimeGeneration: first, outcome: "recovered" });
    expect(sink.mock.calls[3]![0]).toMatchObject({ code: "runtime.reconnected", runtimeGeneration: second, correlationId: warning.id });
  });
});
