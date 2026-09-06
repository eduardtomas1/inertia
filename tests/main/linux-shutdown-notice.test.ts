import { afterEach, describe, expect, it, vi } from "vitest";

import { createLinuxLifecycleNotices, LinuxShutdownNotice } from "../../src/main/linux-shutdown-notice";

afterEach(() => vi.unstubAllEnvs());

function fixture(platform: NodeJS.Platform = "linux", automated = false) {
  const options = {
    platform, automated, version: "0.0.51",
    showMessageBox: vi.fn(async () => ({ response: 1 })),
    retryQuit: vi.fn(), focusWindow: vi.fn(), reportError: vi.fn(),
  };
  return { ...options, notice: new LinuxShutdownNotice(options) };
}

describe("Linux unconfirmed shutdown notice", () => {
  it("makes the retained process visible and explains why another version cannot open", async () => {
    const state = fixture();
    await state.notice.show();
    expect(state.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: "Inertia 0.0.51 could not finish closing.",
      detail: expect.stringContaining("another version cannot open this workspace yet"),
      cancelId: 1,
    }));
    expect(state.focusWindow).toHaveBeenCalledOnce();
    expect(state.retryQuit).not.toHaveBeenCalled();
  });

  it("coalesces repeated failures and retries only after an explicit choice", async () => {
    const state = fixture();
    let answer!: (value: { response: number }) => void;
    state.showMessageBox.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const first = state.notice.show();
    expect(state.notice.show()).toBe(first);
    await Promise.resolve();
    expect(state.showMessageBox).toHaveBeenCalledOnce();
    expect(state.retryQuit).not.toHaveBeenCalled();
    answer({ response: 0 });
    await first;
    expect(state.retryQuit).toHaveBeenCalledOnce();
    expect(state.focusWindow).not.toHaveBeenCalled();

    state.showMessageBox.mockResolvedValue({ response: 1 });
    await state.notice.show();
    expect(state.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("allows a new failure from the explicit retry to display once", async () => {
    const state = fixture();
    state.showMessageBox.mockResolvedValueOnce({ response: 0 });
    let retriedNotice: Promise<void> | undefined;
    state.retryQuit.mockImplementation(() => { retriedNotice = state.notice.show(); });
    await state.notice.show();
    await retriedNotice;
    expect(state.showMessageBox).toHaveBeenCalledTimes(2);
    expect(state.retryQuit).toHaveBeenCalledOnce();
    expect(state.focusWindow).toHaveBeenCalledOnce();
  });

  it("reports a dialog failure without quitting and permits another attempt", async () => {
    const state = fixture();
    const failure = new Error("dialog unavailable");
    state.showMessageBox.mockRejectedValueOnce(failure);
    await state.notice.show();
    expect(state.reportError).toHaveBeenCalledWith(failure);
    expect(state.retryQuit).not.toHaveBeenCalled();
    await state.notice.show();
    expect(state.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it.each(["win32", "darwin"] as const)("preserves %s shutdown behavior", async (platform) => {
    const state = fixture(platform);
    await state.notice.show();
    expect(state.showMessageBox).not.toHaveBeenCalled();
    expect(state.retryQuit).not.toHaveBeenCalled();
    expect(state.focusWindow).not.toHaveBeenCalled();
  });

  it("does not leave native dialogs behind automated fixtures", async () => {
    const state = fixture("linux", true);
    await state.notice.show();
    expect(state.showMessageBox).not.toHaveBeenCalled();
  });
});

describe("Linux lifecycle notice wiring", () => {
  it("waits for Electron readiness and keeps contention pending until its dialog closes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    let ready!: () => void;
    let dismiss!: () => void;
    const application = {
      getVersion: () => "0.0.51", quit: vi.fn(),
      whenReady: () => new Promise<void>((resolve) => { ready = resolve; }),
    };
    const nativeDialog = { showMessageBox: vi.fn(() => new Promise<{
      response: number; checkboxChecked: boolean;
    }>((resolve) => { dismiss = () => resolve({ response: 0, checkboxChecked: false }); })) };
    const notices = createLinuxLifecycleNotices(application, nativeDialog, vi.fn());
    let settled = false;
    const pending = notices.reportSingletonContention({
      requestedVersion: "0.0.51", runningVersion: "0.0.47",
    }).then(() => { settled = true; });
    expect(nativeDialog.showMessageBox).not.toHaveBeenCalled();
    ready();
    await Promise.resolve();
    expect(nativeDialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: "Inertia 0.0.51 did not open.",
      detail: expect.stringContaining("Inertia 0.0.47"),
    }));
    expect(settled).toBe(false);
    dismiss();
    await pending;
    expect(application.quit).not.toHaveBeenCalled();
  });

  it("does not display native contention dialogs in automated fixtures", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const application = {
      getVersion: () => "0.0.51", quit: vi.fn(), whenReady: vi.fn(async () => undefined),
    };
    const nativeDialog = {
      showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    };
    const notices = createLinuxLifecycleNotices(application, nativeDialog, vi.fn());
    await notices.reportSingletonContention({ requestedVersion: "0.0.51", runningVersion: null });
    expect(application.whenReady).not.toHaveBeenCalled();
    expect(nativeDialog.showMessageBox).not.toHaveBeenCalled();
  });
});
