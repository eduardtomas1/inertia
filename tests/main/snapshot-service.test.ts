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
import { SnapshotService, snapshotFailureMessage, snapshotWorkerEnvironment } from "../../src/main/snapshot-service";
import { SNAPSHOT_FAILURE_CATEGORIES } from "../../src/shared/snapshots";

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
  const onFailure = vi.fn();
  const service = new SnapshotService(onCapture, onFailure);
  services.push(service);
  await service.configure(true, "accelerator");
  const child = new Child(); native.fork.mockReturnValue(child);
  return { service, child, onCapture, onFailure };
}

function withPlatform(platform: NodeJS.Platform): () => void {
  const prior = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...prior, value: platform });
  return () => Object.defineProperty(process, "platform", prior);
}

describe("snapshot native worker ownership", () => {
  it.runIf(process.platform === "linux")("normalizes an old both-Shift setting to the working Linux accelerator", async () => {
    const service = new SnapshotService(async () => undefined); services.push(service);
    expect(await service.configure(true, "both-shift")).toMatchObject({ enabled: true, shortcut: "accelerator" });
    expect(native.register).toHaveBeenCalledWith("CommandOrControl+Alt+S", expect.any(Function));
    expect(native.fork).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "linux")("stops an active capture even when shortcut-worker cleanup times out", async () => {
    vi.useFakeTimers();
    const service = new SnapshotService(async () => undefined); services.push(service);
    const poller = new Child(); native.fork.mockReturnValueOnce(poller);
    const configured = service.configure(true, "both-shift");
    await vi.waitFor(() => expect(native.fork).toHaveBeenCalledOnce());
    poller.emit("message", "ready"); await configured;
    const captureChild = new Child(); native.fork.mockReturnValueOnce(captureChild);
    const capture = service.capture(); const captureFailure = expect(capture).rejects.toThrow("stopped");
    poller.kill.mockImplementation(() => true);
    const stopping = service.dispose(); const failure = expect(stopping).rejects.toThrow("cleanup is unconfirmed");
    await vi.advanceTimersByTimeAsync(3000); await failure; await captureFailure;
    expect(captureChild.kill).toHaveBeenCalledOnce();
    poller.emit("exit", 1);
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it("starts disabled and leaves capture permissions untouched", () => {
    const service = new SnapshotService(async () => undefined); services.push(service);
    expect(service.state().enabled).toBe(false);
    expect(native.fork).not.toHaveBeenCalled();
    expect(native.accessibility.mock.calls.every((args) => args[0] !== true)).toBe(true);
  });

  it("invalidates capture ownership synchronously before disposal waits for worker exit", async () => {
    const { service, child } = await fixture(); const controller = new AbortController();
    child.kill.mockImplementation(() => true);
    const capture = service.capture(controller.signal); const failure = expect(capture).rejects.toThrow("stopped");
    expect(service.isDisposing()).toBe(false);
    const stopping = service.dispose();
    expect(service.isDisposing()).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1); await stopping; await failure;
    expect(service.isDisposing()).toBe(true);
  });

  it.each(["before-disable", "after-disable"])("revokes a held worker with a successful result %s and waits for its exit", async (resultTime) => {
    const { service, child } = await fixture(); child.kill.mockImplementation(() => true);
    const result = { ok: true, png: Buffer.alloc(10), source: snapshotFixture() };
    const capture = service.capture();
    const outcome = capture.then(() => "delivered", (error: Error) => error.message);
    if (resultTime === "before-disable") child.emit("message", result);
    let acknowledged = false;
    const disabling = service.configure(false, "accelerator").then((state) => { acknowledged = true; return state; });
    const enabledAfterRequest = service.state().enabled;
    const killedBeforeExit = child.kill.mock.calls.length;
    await Promise.resolve(); await Promise.resolve();
    const acknowledgedBeforeExit = acknowledged;
    if (resultTime === "after-disable") child.emit("message", result);
    child.emit("exit", 0);
    await disabling;
    expect(await outcome).toContain("cancelled");
    expect(enabledAfterRequest).toBe(false);
    expect(killedBeforeExit).toBe(1);
    expect(acknowledgedBeforeExit).toBe(false);
    expect(service.isDisposing()).toBe(false);
    expect((await service.configure(true, "accelerator")).enabled).toBe(true);
    const nextChild = new Child(); native.fork.mockReturnValueOnce(nextChild);
    const next = service.capture(); nextChild.emit("message", result); nextChild.emit("exit", 0);
    expect((await next).source).toEqual(snapshotFixture());
  });

  it("revokes a successful exit before its capture continuation can deliver bytes", async () => {
    const { service, child } = await fixture();
    const capture = service.capture();
    const outcome = capture.then(() => "delivered", (error: Error) => error.message);
    child.emit("message", { ok: true, png: Buffer.alloc(10), source: snapshotFixture() });
    child.emit("exit", 0);
    await service.configure(false, "accelerator");
    expect(await outcome).toContain("cancelled");
  });

  it("does not start capture if the revoked worker spawns after the stop request", async () => {
    const { service, child } = await fixture(); child.kill.mockImplementation(() => true);
    const capture = service.capture(); const failure = expect(capture).rejects.toThrow("cancelled");
    const disabling = service.configure(false, "accelerator");
    child.emit("spawn");
    expect(child.postMessage).not.toHaveBeenCalledWith("capture");
    expect(child.kill).toHaveBeenCalledTimes(2);
    child.emit("exit", 0); await failure; await disabling;
  });

  it("rejects disable acknowledgment when its held worker exit remains unconfirmed", async () => {
    vi.useFakeTimers();
    const { service, child } = await fixture(); child.kill.mockImplementation(() => true);
    const capture = service.capture(); const captureFailure = expect(capture).rejects.toThrow("cleanup is unconfirmed");
    const disabling = service.configure(false, "accelerator"); const disableFailure = expect(disabling).rejects.toThrow("cleanup is unconfirmed");
    await vi.advanceTimersByTimeAsync(3000); await captureFailure; await disableFailure;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(service.isDisposing()).toBe(false);
    expect(native.unregister).toHaveBeenCalled();
    expect((await service.configure(true, "accelerator")).enabled).toBe(false);
    child.emit("exit", 0);
  });

  it("keeps failure reporting valid when an unconfirmed capture only disables future work", async () => {
    vi.useFakeTimers();
    const { service, child } = await fixture(); child.kill.mockImplementation(() => true);
    const capture = service.capture(); const failure = expect(capture).rejects.toThrow("Restart Inertia");
    await vi.advanceTimersByTimeAsync(13_000); await failure;
    expect(service.state().enabled).toBe(false);
    expect(service.isDisposing()).toBe(false);
    child.emit("exit", 1);
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

describe("snapshot failure reasons", () => {
  it.each(SNAPSHOT_FAILURE_CATEGORIES)("delivers the %s category as its specific message and a phase-only diagnostic", async (category) => {
    const { service, child, onFailure } = await fixture();
    const capture = service.capture(); const outcome = capture.then(() => "delivered", (error: Error) => error.message);
    child.emit("message", { ok: false, code: category, phase: "verification" });
    child.emit("exit", 0);
    const message = await outcome;
    expect(message).toBe(snapshotFailureMessage(category));
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({ category, phase: "verification" });
    if (category !== "permission-denied") expect(message).not.toMatch(/permission|denied/iu);
  });

  it("gives Linux-only accessibility bridge guidance and claims denial only from a denial", () => {
    expect(snapshotFailureMessage("accessibility-unavailable", "linux")).toContain("--force-renderer-accessibility");
    expect(snapshotFailureMessage("accessibility-unavailable", "linux")).toContain("ACCESSIBILITY_ENABLED=1");
    for (const platform of ["darwin", "win32"] as const) expect(snapshotFailureMessage("accessibility-unavailable", platform)).not.toContain("--force-renderer-accessibility");
    expect(snapshotFailureMessage("permission-denied", "darwin")).toContain("Screen Recording");
    expect(snapshotFailureMessage("permission-denied", "linux")).not.toContain("Screen Recording");
    expect(snapshotFailureMessage("no-active-window", "linux")).toMatch(/focus.*press the shortcut again/u);
  });

  it("collapses unknown worker codes and phases to a native failure without forwarding worker text", async () => {
    const { service, child, onFailure } = await fixture();
    const capture = service.capture(); const failure = expect(capture).rejects.toThrow(snapshotFailureMessage("native-failure"));
    child.emit("message", { ok: false, code: "Google Chrome: private title", phase: "/home/alice", detail: "raw native detail" });
    child.emit("exit", 0); await failure;
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({ category: "native-failure" });
  });

  it("records a timed-out capture as a category-only diagnostic", async () => {
    vi.useFakeTimers();
    const { service, onFailure } = await fixture();
    const capture = service.capture(); const failure = expect(capture).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000); await failure;
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({ category: "timed-out" });
  });

  it.each([["linux", "unverified"], ["win32", "unverified"]] as const)("does not report an unverified %s permission as granted", (platform, permission) => {
    const restore = withPlatform(platform);
    try {
      const service = new SnapshotService(async () => undefined); services.push(service);
      expect(service.state().permission).toBe(permission);
      expect(native.accessibility).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("reports macOS permission from the system checks", () => {
    const restore = withPlatform("darwin");
    try {
      const service = new SnapshotService(async () => undefined); services.push(service);
      expect(service.state().permission).toBe("granted");
      native.screen.mockReturnValueOnce("denied");
      expect(service.state().permission).toBe("required");
    } finally { restore(); }
  });
});
