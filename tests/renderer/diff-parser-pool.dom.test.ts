import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("diff parser worker pool failures", () => {
  it("turns synchronous worker construction failure into a stable rejection", async () => {
    vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(2);
    const construct = vi.fn(() => {
      throw new Error("Module workers are unavailable.");
    });
    vi.stubGlobal("Worker", class {
      constructor() {
        construct();
      }
    });
    const { parseDiffOffMainThread } = await import(
      "../../src/renderer/src/utils/diffParserPool"
    );

    let first!: Promise<unknown>;
    expect(() => {
      first = parseDiffOffMainThread("large patch", new AbortController().signal);
    }).not.toThrow();
    await expect(first).rejects.toThrow("Module workers are unavailable.");
    await expect(parseDiffOffMainThread(
      "another patch",
      new AbortController().signal,
    )).rejects.toThrow("Module workers are unavailable.");
    expect(construct).toHaveBeenCalledTimes(1);
  });

  it("disables a broken slot instead of respawning it forever", async () => {
    vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(2);
    const workers: FakeWorker[] = [];
    class FakeWorker {
      readonly listeners = new Map<string, EventListener[]>();
      readonly terminate = vi.fn();

      constructor() {
        workers.push(this);
      }

      addEventListener(type: string, listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      postMessage(): void {}

      emitError(): void {
        const event = new Event("error", { cancelable: true });
        for (const listener of this.listeners.get("error") ?? []) {
          listener(event);
        }
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const { parseDiffOffMainThread } = await import(
      "../../src/renderer/src/utils/diffParserPool"
    );

    const first = parseDiffOffMainThread(
      "large patch",
      new AbortController().signal,
    );
    expect(workers).toHaveLength(1);
    workers[0]?.emitError();

    await expect(first).rejects.toThrow(
      "The diff parser worker stopped unexpectedly.",
    );
    await expect(parseDiffOffMainThread(
      "another patch",
      new AbortController().signal,
    )).rejects.toThrow("The diff parser worker is unavailable.");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
  });
});
