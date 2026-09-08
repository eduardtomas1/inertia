import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotFixture } from "../helpers/snapshot-fixture";

const native = vi.hoisted(() => ({ fork: vi.fn(), register: vi.fn(() => true), unregister: vi.fn(), screen: vi.fn(() => "granted"), accessibility: vi.fn((_prompt: boolean) => true) }));
vi.mock("electron", () => ({
  app: { getPath: () => "/private/test-data" },
  utilityProcess: { fork: native.fork },
  globalShortcut: { register: native.register, unregister: native.unregister },
  systemPreferences: { getMediaAccessStatus: native.screen, isTrustedAccessibilityClient: native.accessibility },
}));
import { SnapshotService, snapshotWorkerEnvironment } from "../../src/main/snapshot-service";

class Child extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => { this.emit("exit", 1); return true; });
}
const services: SnapshotService[] = [];
beforeEach(() => { vi.stubEnv("DISPLAY", ":0"); vi.stubEnv("WAYLAND_DISPLAY", ""); vi.stubEnv("XDG_SESSION_TYPE", "x11"); });
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllEnvs();
});

async function fixture() {
  const onCapture = vi.fn(async () => undefined);
  const service = new SnapshotService(onCapture);
  services.push(service);
  await service.configure(true, "accelerator");
  const child = new Child(); native.fork.mockReturnValue(child);
  return { service, child, onCapture };
}

describe("snapshot native worker ownership", () => {
  it("starts disabled and leaves capture permissions untouched", () => {
    const service = new SnapshotService(async () => undefined); services.push(service);
    expect(service.state().enabled).toBe(false);
    expect(native.fork).not.toHaveBeenCalled();
    expect(native.accessibility.mock.calls.every((args) => args[0] !== true)).toBe(true);
  });

  it("does not deliver bytes until the exact worker exits", async () => {
    const { service, child } = await fixture();
    const capture = service.capture(); const delivered = vi.fn(); void capture.then(delivered);
    child.emit("spawn");
    expect(child.postMessage).toHaveBeenCalledWith("capture");
    child.emit("message", { ok: true, png: Buffer.alloc(10), source: snapshotFixture() });
    await Promise.resolve(); expect(delivered).not.toHaveBeenCalled();
    expect(child.postMessage).toHaveBeenCalledWith("received");
    child.emit("exit", 0);
    expect((await capture).source).toEqual(snapshotFixture());
  });

  it("rejects concurrent work and kills a cancelled capture before allowing another", async () => {
    const { service, child } = await fixture();
    const controller = new AbortController();
    const capture = service.capture(controller.signal); const failure = expect(capture).rejects.toThrow("cancelled");
    await expect(service.capture()).rejects.toThrow("already capturing");
    controller.abort(); await failure; expect(child.kill).toHaveBeenCalledOnce();
  });

  it("times out hung native reads and waits for process exit", async () => {
    vi.useFakeTimers();
    const { service, child } = await fixture();
    const capture = service.capture(); const failure = expect(capture).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000); await failure;
    expect(child.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.state().enabled).toBe(true);
  });

  it("rejects oversized or malformed capture output", async () => {
    const { service, child } = await fixture();
    const capture = service.capture(); const failure = expect(capture).rejects.toThrow("could not be captured");
    child.emit("message", { ok: true, png: Buffer.alloc(10), source: { ...snapshotFixture(), width: 100000 } });
    child.emit("exit", 0); await failure;
  });

  it("passes no provider credentials or dynamic runtime loader options to workers", () => {
    expect(snapshotWorkerEnvironment({ DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/test/bus", OPENAI_API_KEY: "fixture", NODE_OPTIONS: "--require=unsafe", DYLD_INSERT_LIBRARIES: "unsafe" })).toEqual({ DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/test/bus" });
  });

  it("preserves X11 authority lookup without requiring XAUTHORITY", () => {
    expect(snapshotWorkerEnvironment({ HOME: "/home/snapshot-user", DISPLAY: ":1" })).toEqual({ HOME: "/home/snapshot-user", DISPLAY: ":1" });
    expect(snapshotWorkerEnvironment({ HOME: "/home/snapshot-user", XAUTHORITY: "/run/user/1000/Xauthority" })).toEqual({ HOME: "/home/snapshot-user", XAUTHORITY: "/run/user/1000/Xauthority" });
    expect(snapshotWorkerEnvironment({ HOME: "relative-home" })).toEqual({});
    expect(snapshotWorkerEnvironment({ HOME: "/home/invalid\0" })).toEqual({});
  });
});
