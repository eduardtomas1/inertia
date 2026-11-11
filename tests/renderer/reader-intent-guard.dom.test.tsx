import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startReaderIntentGuard } from "../../src/renderer/src/utils/readerIntentGuard";

describe("reader intent guard", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const runFrame = (): void => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => { frames.delete(frame); });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ends only after the frames that report scrolling up to its time have been delivered", () => {
    const release = vi.fn();
    startReaderIntentGuard(release);
    vi.advanceTimersByTime(749);
    expect(frames.size).toBe(0);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(4_999);
    expect(release).not.toHaveBeenCalled();
    runFrame();
    expect(release).not.toHaveBeenCalled();
    runFrame();
    expect(release).toHaveBeenCalledOnce();
    runFrame();
    vi.advanceTimersByTime(10_000);
    expect(release).toHaveBeenCalledOnce();
  });

  it("ends five seconds after its time in a window that reports itself visible but renders no frame", () => {
    const release = vi.fn();
    startReaderIntentGuard(release);
    vi.advanceTimersByTime(750 + 4_999);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    runFrame();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2])("never ends once it was stopped after %i frames", (deliveredFrames) => {
    const release = vi.fn();
    const stop = startReaderIntentGuard(release);
    vi.advanceTimersByTime(deliveredFrames === 0 ? 400 : 750);
    for (let frame = 1; frame < deliveredFrames; frame++) runFrame();
    stop();
    vi.advanceTimersByTime(5_000);
    runFrame();
    runFrame();
    expect(release).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("ends at its time in a hidden window, which renders no frames and reports no scrolling", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const release = vi.fn();
    startReaderIntentGuard(release);
    vi.advanceTimersByTime(750);
    expect(release).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
});
