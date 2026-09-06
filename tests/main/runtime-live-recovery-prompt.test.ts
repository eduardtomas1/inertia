import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(), authorize: vi.fn(), message: vi.fn(), error: vi.fn(),
}));
vi.mock("electron", () => ({ dialog: {
  showMessageBox: mocks.message, showErrorBox: mocks.error,
} }));
vi.mock("../../src/main/runtime-bootstrap-safety", () => ({
  prepareModernDarwinBootstrapRecovery: mocks.prepare,
  authorizeModernDarwinRuntimeRecovery: mocks.authorize,
  MODERN_DARWIN_RECOVERY_DIALOG_DETAIL: "Exact recovery consent detail",
}));
import { promptForLiveModernDarwinRuntimeRecovery } from
  "../../src/main/runtime-bootstrap-recovery";

const candidate = { snapshotDigest: "a".repeat(64) };
const authority = {
  operationId: "00000000-0000-4000-8000-000000000001",
  snapshotDigest: "a".repeat(64),
  runtimeGenerationIds: ["30000000-0000-4000-8000-000000000003:4"],
};
function fixture() {
  const events = new EventEmitter();
  let destroyed = false;
  const window = Object.assign(events, { isDestroyed: () => destroyed }) as BrowserWindow;
  return {
    window,
    close: () => { destroyed = true; events.emit("closed"); },
    prompt: () => promptForLiveModernDarwinRuntimeRecovery(
      "/tmp/data", "test:boot", "/tmp/guardian", window,
    ),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prepare.mockResolvedValue({ blocked: false, authority: null, candidate });
  mocks.authorize.mockReturnValue(authority);
  mocks.message.mockResolvedValue({ response: 1, checkboxChecked: false });
});

describe("live macOS recovery prompt", () => {
  it("keeps refusal as the default and cancel decision on a parented sheet", async () => {
    const run = fixture();
    await expect(run.prompt()).resolves.toBeNull();
    expect(mocks.message).toHaveBeenCalledWith(run.window, expect.objectContaining({
      buttons: ["I closed them — recover", "Keep safety lock"],
      defaultId: 1, cancelId: 1, signal: expect.any(AbortSignal),
    }));
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(run.window.listenerCount("closed")).toBe(0);
  });

  it("revalidates the exact prepared candidate only after explicit consent", async () => {
    const run = fixture();
    mocks.message.mockResolvedValue({ response: 0, checkboxChecked: false });
    await expect(run.prompt()).resolves.toBe(authority);
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith(
      "/tmp/data", candidate, "test:boot", "/tmp/guardian",
    );
    expect(run.window.listenerCount("closed")).toBe(0);
  });

  it("aborts a pending decision when its parent closes without authorizing recovery", async () => {
    const run = fixture();
    let signal: AbortSignal | undefined;
    mocks.message.mockImplementation(async (_window, options) => {
      signal = options.signal;
      run.close();
      return { response: 0, checkboxChecked: false };
    });
    await expect(run.prompt()).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(run.window.listenerCount("closed")).toBe(0);
  });

  it("retains the lock if the parent closes during exact preparation", async () => {
    const run = fixture();
    mocks.prepare.mockImplementation(async () => {
      run.close();
      return { blocked: false, authority, candidate: null };
    });
    await expect(run.prompt()).resolves.toBeNull();
    expect(mocks.message).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("does not prepare recovery for an already destroyed window", async () => {
    const run = fixture();
    run.close();
    await expect(run.prompt()).resolves.toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("uses a parented error sheet when the journal cannot be verified", async () => {
    const run = fixture();
    mocks.prepare.mockResolvedValue({ blocked: true, authority: null, candidate: null });
    await expect(run.prompt()).resolves.toBeNull();
    expect(mocks.message).toHaveBeenCalledWith(run.window, expect.objectContaining({
      type: "error", title: "Runtime recovery remains safety locked",
      buttons: ["Keep safety lock"], defaultId: 0, cancelId: 0,
    }));
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("keeps a changed candidate locked and reports it through a parented error sheet", async () => {
    const run = fixture();
    mocks.message.mockResolvedValue({ response: 0, checkboxChecked: false });
    mocks.authorize.mockReturnValue(null);
    await expect(run.prompt()).resolves.toBeNull();
    expect(mocks.message).toHaveBeenNthCalledWith(2, run.window, expect.objectContaining({
      type: "error", title: "Runtime recovery was not authorized",
      buttons: ["Keep safety lock"], defaultId: 0, cancelId: 0,
    }));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each([null, authority])("preserves an exact automatic preparation result without a prompt", async (preparedAuthority) => {
    const run = fixture();
    mocks.prepare.mockResolvedValue({ blocked: false, authority: preparedAuthority, candidate: null });
    await expect(run.prompt()).resolves.toBe(preparedAuthority);
    expect(mocks.message).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(run.window.listenerCount("closed")).toBe(0);
  });

  it("releases the close listener when the native dialog rejects", async () => {
    const run = fixture();
    mocks.message.mockRejectedValue(new Error("native dialog unavailable"));
    await expect(run.prompt()).rejects.toThrow("native dialog unavailable");
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(run.window.listenerCount("closed")).toBe(0);
  });
});
