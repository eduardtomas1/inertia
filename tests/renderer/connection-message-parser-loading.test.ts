import { afterEach, describe, expect, it, vi } from "vitest";

describe("connection message parser loading", () => {
  afterEach(() => {
    vi.doUnmock("@shared/contracts/server-event-schema");
    vi.resetModules();
  });

  it("does not start the deferred server schema import for delivery-only helpers", async () => {
    const moduleLoaded = vi.fn();
    const parseServerEvent = vi.fn((value: unknown) => value);
    vi.doMock("@shared/contracts/server-event-schema", () => {
      moduleLoaded();
      return { parseServerEvent };
    });

    const connectionMessages = await import(
      "../../src/renderer/src/utils/connectionMessages"
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(connectionMessages.runtimeCommandDelivery(new Error("offline")))
      .toBeNull();
    expect(moduleLoaded).not.toHaveBeenCalled();

    const event = { type: "runtime.ready", websocketUrl: "ws://127.0.0.1" };
    await expect(connectionMessages.decodeServerEventMessage(
      JSON.stringify(event),
    )).resolves.toEqual(event);
    expect(moduleLoaded).toHaveBeenCalledOnce();
    expect(parseServerEvent).toHaveBeenCalledWith(event);
  });

  it("retries the deferred schema load after one transient rejection", async () => {
    let attempt = 0;
    const parseServerEvent = vi.fn((value: unknown) => value);
    vi.doMock("@shared/contracts/server-event-schema", () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary chunk failure");
      return { parseServerEvent };
    });

    const { decodeServerEventMessage } = await import(
      "../../src/renderer/src/utils/connectionMessages"
    );
    const event = { type: "runtime.ready", websocketUrl: "ws://127.0.0.1" };
    await expect(decodeServerEventMessage(JSON.stringify(event)))
      .rejects.toThrow();
    await expect(decodeServerEventMessage(JSON.stringify(event)))
      .resolves.toEqual(event);
    expect(attempt).toBe(2);
    expect(parseServerEvent).toHaveBeenCalledWith(event);
  });
});
