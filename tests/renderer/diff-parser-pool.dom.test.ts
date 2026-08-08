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

      emitMessage(data: unknown): void {
        const event = new MessageEvent("message", { data });
        for (const listener of this.listeners.get("message") ?? []) {
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

  it("recycles an active slot immediately when its parse is superseded", async () => {
    vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(2);
    const workers: FakeWorker[] = [];
    class FakeWorker {
      readonly listeners = new Map<string, EventListener[]>();
      readonly terminate = vi.fn();
      readonly postMessage = vi.fn();

      constructor() {
        workers.push(this);
      }

      addEventListener(type: string, listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emitMessage(data: unknown): void {
        const event = new MessageEvent("message", { data });
        for (const listener of this.listeners.get("message") ?? []) {
          listener(event);
        }
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const { parseDiffOffMainThread } = await import(
      "../../src/renderer/src/utils/diffParserPool"
    );

    const firstController = new AbortController();
    const first = parseDiffOffMainThread("obsolete", firstController.signal);
    expect(workers).toHaveLength(1);
    firstController.abort();

    await expect(first).rejects.toThrow("Diff parsing was superseded.");
    expect(workers).toHaveLength(2);
    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);

    const second = parseDiffOffMainThread(
      "authoritative",
      new AbortController().signal,
    );
    const secondMessage = workers[1]?.postMessage.mock.calls[0]?.[0] as {
      id: number;
    } | undefined;
    workers[1]?.emitMessage({
      id: secondMessage?.id,
      result: { fingerprint: "ready", files: [] },
    });
    await expect(second).resolves.toEqual({ fingerprint: "ready", files: [] });
  });
});
