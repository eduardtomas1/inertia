import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarUpdateControl } from "../../src/renderer/src/components/sidebar/SidebarUpdateControl";
import { useAppUpdate } from "../../src/renderer/src/hooks/useAppUpdate";
import { nativePreviewSuspended } from "../../src/renderer/src/utils/nativePreviewOverlay";
import type { AppUpdateStatus } from "../../src/shared/desktop";
import { updateStatus } from "../support/app-update-fixture";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}
function Harness(): React.JSX.Element { return <SidebarUpdateControl controller={useAppUpdate()} />; }
let listener: (value: AppUpdateStatus) => void;
let sequence = 0;
const check = vi.fn<() => Promise<AppUpdateStatus>>();
const download = vi.fn<() => Promise<AppUpdateStatus>>();
const install = vi.fn<() => Promise<AppUpdateStatus>>();
const cancel = vi.fn<() => Promise<AppUpdateStatus>>();
const external = vi.fn<() => Promise<void>>();
function publish(overrides: Partial<AppUpdateStatus> = {}): void {
  act(() => listener(updateStatus({ ...overrides, revision: ++sequence })));
}
function trigger(): HTMLButtonElement { return document.querySelector<HTMLButtonElement>(".sidebar-update-button")!; }
function details(): HTMLElement { return screen.getByRole("dialog", { name: "Application update details" }); }
beforeEach(() => {
  vi.useFakeTimers(); sequence = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(window, "inertia", { configurable: true, value: {
    checkAppUpdate: check, downloadAppUpdate: download, installAppUpdate: install,
    cancelAppUpdateDownload: cancel, openExternal: external,
    onAppUpdateStatus: (next: typeof listener) => { listener = next; return vi.fn(); },
  } });
  external.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "inertia");
  expect(nativePreviewSuspended()).toBe(false);
});
describe("real update controller in the sidebar", () => {
  it("distinguishes the startup check rotation from an admitted manual check", async () => {
    const background = deferred<AppUpdateStatus>();
    const manual = deferred<AppUpdateStatus>();
    check.mockReturnValueOnce(background.promise).mockReturnValueOnce(manual.promise);
    render(<Harness />);
    // A direct main-process check can publish current metadata before the hook's
    // scheduled check starts. An idle icon alone does not settle that timer.
    publish({ state: "current", latestVersion: "1.2.2" });
    expect(trigger()).toHaveAttribute("data-update-state", "idle");
    await act(async () => vi.advanceTimersByTime(2_500));
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("data-update-state", "checking");
    expect(check).toHaveBeenCalledExactlyOnceWith(false);
    await act(async () => background.resolve(updateStatus({
      revision: ++sequence, state: "current", latestVersion: "1.2.2", freshness: "cached",
    })));
    // Checking remains visible until its rotation finishes, although no manual
    // request was admitted. Releasing a test adapter gate here would do nothing.
    expect(trigger()).toHaveAttribute("data-update-state", "checking");
    fireEvent.animationIteration(document.querySelector(".update-status-icon")!);
    expect(trigger()).toHaveAttribute("data-update-state", "idle");
    fireEvent.click(trigger());
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenNthCalledWith(2, true);
    await act(async () => manual.resolve(updateStatus({ revision: ++sequence })));
    fireEvent.animationIteration(document.querySelector(".update-status-icon")!);
    expect(trigger()).toHaveAttribute("data-update-state", "available");
  });
  it("checks directly, prevents duplicate clicks, and finishes the current rotation without a timer", async () => {
    const request = deferred<AppUpdateStatus>(); check.mockReturnValue(request.promise);
    render(<Harness />);
    fireEvent.click(trigger()); fireEvent.click(trigger());
    expect(check).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledWith(true);
    expect(trigger()).toHaveAttribute("data-update-state", "checking");
    await act(async () => request.resolve(updateStatus({ state: "current" })));
    expect(trigger()).toHaveAttribute("data-update-state", "checking");
    fireEvent.animationIteration(document.querySelector(".update-status-icon")!);
    expect(trigger()).toHaveAttribute("data-update-state", "idle");
    expect(nativePreviewSuspended()).toBe(false);
  });
  it("does not wait for an animation event when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const request = deferred<AppUpdateStatus>(); check.mockReturnValue(request.promise);
    render(<Harness />); fireEvent.click(trigger());
    expect(document.querySelector(".is-checking")).toBeNull();
    await act(async () => request.resolve(updateStatus()));
    expect(trigger()).toHaveAttribute("data-update-state", "available");
  });
  it("shows safe notes in-place, owns native preview only while open, and closes with Escape without reopening", () => {
    render(<Harness />); publish({ releaseNotes: '<img src="https://untrusted.invalid/tracker" onerror="alert(1)">\n[link](javascript:alert(1))' });
    expect(nativePreviewSuspended()).toBe(false);
    act(() => trigger().focus()); fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(details()).toHaveTextContent("<img src=");
    expect(details().querySelector("img, a, script")).toBeNull();
    expect(nativePreviewSuspended()).toBe(true);
    fireEvent.keyDown(details(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger()).toHaveFocus();
    expect(nativePreviewSuspended()).toBe(false);
    fireEvent.pointerEnter(trigger().parentElement!);
    fireEvent.click(screen.getByRole("button", { name: "Close update details" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("preserves a hover corridor and cancels pending close on re-entry", async () => {
    render(<Harness />); publish();
    fireEvent.pointerEnter(trigger().parentElement!);
    fireEvent.pointerLeave(trigger().parentElement!);
    await act(async () => vi.advanceTimersByTime(100)); expect(details()).toBeInTheDocument();
    fireEvent.pointerEnter(details());
    await act(async () => vi.advanceTimersByTime(100)); expect(details()).toBeInTheDocument();
    fireEvent.pointerLeave(trigger().parentElement!);
    await act(async () => vi.advanceTimersByTime(150)); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("dismisses on outside click or Escape without moving focus from the user's editor", () => {
    render(<><input aria-label="Editor" /><Harness /></>); publish();
    const editor = screen.getByRole("textbox", { name: "Editor" });
    act(() => editor.focus()); fireEvent.pointerEnter(trigger().parentElement!);
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(editor).toHaveFocus();
    fireEvent.pointerEnter(trigger().parentElement!); fireEvent.pointerDown(editor);
    expect(screen.queryByRole("dialog")).toBeNull(); expect(editor).toHaveFocus();
  });
  it("keeps hover ownership when native focus leaves a changing download action", async () => {
    render(<Harness />); publish({ state: "downloading" });
    const control = trigger().parentElement!;
    fireEvent.pointerEnter(control);
    const cancelButton = screen.getByRole("button", { name: "Cancel download" });
    fireEvent.focus(cancelButton);
    // On macOS, a pointer action need not move focus to the trigger. A removed
    // or disabled action can instead blur to the document while still hovered.
    fireEvent.blur(cancelButton, { relatedTarget: document.body });
    publish({ state: "failed", message: "The update could not be downloaded." });
    await act(async () => vi.advanceTimersByTime(200));
    expect(details()).toHaveTextContent("The update could not be downloaded.");
    fireEvent.pointerLeave(control);
    await act(async () => vi.advanceTimersByTime(150));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(nativePreviewSuspended()).toBe(false);
  });
  it("cancels the panel leave timer when moving back to its trigger inside the same control", async () => {
    render(<Harness />); publish();
    fireEvent.pointerEnter(trigger().parentElement!);
    const panel = details();
    fireEvent.pointerEnter(panel);
    // Both nodes share the wrapper: its pointer-enter event does not fire again.
    fireEvent.pointerOut(panel, { relatedTarget: trigger() });
    fireEvent.pointerOver(trigger(), { relatedTarget: panel });
    await act(async () => vi.advanceTimersByTime(200));
    expect(details()).toBeInTheDocument();
    fireEvent.pointerOut(trigger(), { relatedTarget: document.body });
    await act(async () => vi.advanceTimersByTime(150));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps cancel and release notes usable during a pending download; a stale response cannot overwrite cancellation", async () => {
    const request = deferred<AppUpdateStatus>(); download.mockReturnValue(request.promise);
    cancel.mockImplementation(async () => updateStatus({ revision: ++sequence, state: "cancelled" }));
    render(<Harness />); publish(); fireEvent.click(trigger()); fireEvent.click(trigger());
    expect(download).toHaveBeenCalledTimes(1);
    publish({ state: "downloading", progress: { percent: 42.7, totalBytes: 100, transferredBytes: 43, bytesPerSecond: 10 } });
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "43");
    expect(document.querySelector(".update-progress-value")).toHaveAttribute("stroke-dashoffset", "57");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Release notes" })));
    expect(external).toHaveBeenCalledOnce();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel download" })));
    await act(async () => request.resolve(updateStatus({ revision: 1, state: "downloaded" })));
    expect(trigger()).toHaveAttribute("data-update-state", "available");
    expect(install).not.toHaveBeenCalled();
  });
  it("never invents zero percent for indeterminate progress and never downloads on manual installs", async () => {
    render(<Harness />); publish({ state: "downloading" });
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(trigger()).toHaveAccessibleName("Downloading update…");
    publish({ delivery: "manual", deliveryReason: "windows-signing-unavailable" });
    await act(async () => fireEvent.click(trigger()));
    expect(external).toHaveBeenCalledOnce(); expect(download).not.toHaveBeenCalled();
  });
  it("requires explicit restart confirmation, defaults to cancel and rejects a changed candidate", () => {
    render(<Harness />); publish({ state: "downloaded" });
    fireEvent.click(trigger());
    expect(install).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Not now" })).toHaveFocus();
    expect(nativePreviewSuspended()).toBe(true);
    publish({ state: "downloaded", latestVersion: "1.2.4" });
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger()).toHaveFocus();
    expect(install).not.toHaveBeenCalled();
  });
  it("keeps the main-process active-work blocker visible after confirmed restart is refused", async () => {
    install.mockImplementation(async () => updateStatus({ revision: ++sequence, state: "downloaded", installBlocker: "active-work",
      message: "Finish active agent work before restarting to update." }));
    render(<Harness />); publish({ state: "downloaded" }); fireEvent.click(trigger());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Restart to update" })));
    expect(install).toHaveBeenCalledOnce(); expect(trigger()).toHaveAttribute("data-update-state", "attention");
    fireEvent.keyDown(trigger(), { key: "ArrowUp" }); expect(details()).toHaveTextContent("Finish active agent work");
  });
  it("presents a sanitized external-browser failure without leaking bridge details", async () => {
    external.mockRejectedValue(new Error("private path /secret"));
    render(<Harness />); publish({ delivery: "manual" });
    await act(async () => fireEvent.click(trigger()));
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(details()).toHaveTextContent("The release page could not be opened");
    expect(document.body).not.toHaveTextContent("/secret");
  });
});
