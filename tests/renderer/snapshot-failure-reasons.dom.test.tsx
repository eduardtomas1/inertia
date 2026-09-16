import { EventEmitter } from "node:events";
import { act, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SnapshotDelivery } from "../../src/shared/snapshots";

const native = vi.hoisted(() => {
  class XA11yError extends Error {}
  return {
    foreground: vi.fn(), screenshot: vi.fn(), fork: vi.fn(),
    AccessibilityNotEnabledError: class extends XA11yError {},
  };
});
vi.mock("@crowecawcaw/xa11y", () => ({ default: {
  App: { foreground: native.foreground, byPid: native.foreground }, screenshot: native.screenshot,
  AccessibilityNotEnabledError: native.AccessibilityNotEnabledError,
  PermissionDeniedError: class extends Error {}, SelectorNotMatchedError: class extends Error {},
} }));
vi.mock("../../src/main/snapshot-x11-foreground", () => ({
  readX11Foreground: () => ({ id: 100, pid: 123, name: "Private roadmap" }),
  matchesX11Bounds: () => true,
  SnapshotX11ForegroundError: class extends Error {},
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/private/test-data" },
  utilityProcess: { fork: native.fork },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => "granted"), isTrustedAccessibilityClient: vi.fn(() => true) },
}));
import { SnapshotService } from "../../src/main/snapshot-service";
import { SnapshotControl } from "../../src/renderer/src/components/composer/SnapshotControl";
import { useComposerSnapshots } from "../../src/renderer/src/components/composer/useComposerSnapshots";

const original = window.inertia;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const window_ = { active: true, stableId: "fixture-window", name: "Private roadmap", role: "window", value: null, raw: {}, bounds: { x: 0, y: 0, width: 100, height: 100 }, children: async () => [] };
beforeEach(() => { vi.stubEnv("DISPLAY", ":0"); vi.stubEnv("WAYLAND_DISPLAY", ""); vi.stubEnv("XDG_SESSION_TYPE", "x11"); });
afterEach(() => { window.inertia = original; vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

async function workerResult(): Promise<unknown> {
  const prior = Object.getOwnPropertyDescriptor(process, "parentPort");
  vi.useFakeTimers();
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  Object.defineProperty(process, "parentPort", { configurable: true, value: port });
  try {
    vi.resetModules(); await import("../../src/main/snapshot-capture-worker");
    port.emit("message", { data: "capture" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.postMessage).toHaveBeenCalledOnce();
    port.emit("message", { data: "received" });
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    return port.postMessage.mock.calls[0]![0];
  } finally {
    exit.mockRestore(); vi.useRealTimers();
    if (prior) Object.defineProperty(process, "parentPort", prior);
    else Reflect.deleteProperty(process, "parentPort");
  }
}

async function serviceMessage(result: unknown): Promise<{ message: string; diagnostic: unknown }> {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try {
    const onFailure = vi.fn();
    const service = new SnapshotService(async () => undefined, onFailure);
    expect((await service.configure(true, "accelerator")).enabled).toBe(true);
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn(() => true) });
    native.fork.mockReturnValue(child);
    const capture = service.capture().then(() => "delivered", (error: Error) => error.message);
    child.emit("spawn"); child.emit("message", result); child.emit("exit", 0);
    const message = await capture;
    await service.dispose();
    return { message, diagnostic: onFailure.mock.calls[0]?.[0] };
  } finally { Object.defineProperty(process, "platform", platform); }
}

async function visibleMessage(error: string): Promise<HTMLElement> {
  let listener!: (value: SnapshotDelivery) => void;
  window.inertia = { ...original,
    snapshot: vi.fn(async () => ({ enabled: true, shortcut: "accelerator" as const, available: true, permission: "unverified" as const, message: null })),
    onSnapshot: (fn) => { listener = fn; return () => undefined; },
  };
  function Composer(): React.JSX.Element {
    const textarea = useRef<HTMLTextAreaElement>(null);
    useComposerSnapshots("linux-chat", async () => "adopted", textarea);
    return <><textarea ref={textarea} /><SnapshotControl conversationId="linux-chat" /></>;
  }
  render(<Composer />);
  act(() => listener({ conversationId: "linux-chat", error }));
  return await screen.findByRole("alert");
}

it("explains an empty Chromium accessibility tree on Linux from worker to visible message", async () => {
  native.foreground.mockRejectedValue(new native.AccessibilityNotEnabledError("Accessibility not enabled for Google Chrome: Chromium/Electron app exposes an empty accessibility tree on Linux."));
  const result = await workerResult();
  expect(result).toEqual({ ok: false, code: "accessibility-unavailable", phase: "foreground" });
  expect(native.screenshot).not.toHaveBeenCalled();
  const { message, diagnostic } = await serviceMessage(result);
  expect(diagnostic).toEqual({ category: "accessibility-unavailable", phase: "foreground" });
  const alert = await visibleMessage(message);
  expect(alert).toHaveTextContent("This app is not exposing its accessibility tree, so Inertia cannot find fields to mask and captured nothing.");
  expect(alert).toHaveTextContent("restart the app with --force-renderer-accessibility or with ACCESSIBILITY_ENABLED=1 set");
  expect(alert.textContent).not.toMatch(/Google Chrome|permission|`/iu);
  expect(alert).toHaveClass("snapshot-alert");
  for (const token of ["--force-renderer-accessibility", "ACCESSIBILITY_ENABLED=1"]) expect(within(alert).getByText(token).tagName).toBe("CODE");
  expect(screen.getByRole("dialog", { name: "Snapshots" })).toBeVisible();
});

it("asks for focus when no active window can be identified, from worker to visible message", async () => {
  const inactive = { ...window_, active: false };
  native.foreground.mockResolvedValue({ pid: 123, name: "Fixture", asElement: () => inactive, children: async () => [inactive, { ...inactive }] });
  const result = await workerResult();
  expect(result).toEqual({ ok: false, code: "no-active-window", phase: "foreground" });
  expect(native.foreground).toHaveBeenCalledTimes(3);
  const { message, diagnostic } = await serviceMessage(result);
  expect(diagnostic).toEqual({ category: "no-active-window", phase: "foreground" });
  const alert = await visibleMessage(message);
  expect(alert).toHaveTextContent("Inertia could not identify one active window to capture. Click the window you want to share so it has focus, then press the shortcut again.");
  expect(alert.textContent).not.toMatch(/Private roadmap|permission/iu);
});
