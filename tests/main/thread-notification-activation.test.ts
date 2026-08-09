import { describe, expect, it, vi } from "vitest";

import { activateThreadNotification } from "../../src/main/thread-notification-activation";
import { ThreadNotificationActivationBuffer } from "../../src/preload/thread-notification-activation";

describe("thread notification activation lifecycle", () => {
  it("awaits window recreation and preserves the exact target until the renderer subscribes", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const buffer = new ThreadNotificationActivationBuffer();
    let resolveWindow!: () => void;
    const windowReady = new Promise<void>((resolve) => {
      resolveWindow = resolve;
    });
    const send = vi.fn((_channel: string, target: string) => {
      buffer.receive(target);
    });
    const show = vi.fn();
    const focus = vi.fn();
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show,
      focus,
      webContents: { send },
    };
    let currentWindow: typeof window | null = null;
    const createWindow = vi.fn(async () => {
      await windowReady;
      currentWindow = window;
    });

    const activation = activateThreadNotification(conversationId, {
      channel: "inertia:thread-notification-activated",
      currentWindow: () => currentWindow,
      createWindow,
    });
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    resolveWindow();
    await activation;
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "inertia:thread-notification-activated",
      conversationId,
    );

    const listener = vi.fn();
    buffer.subscribe(listener);
    expect(listener).toHaveBeenCalledWith(conversationId);
  });

  it("keeps the latest exact click while the renderer is still loading", () => {
    const buffer = new ThreadNotificationActivationBuffer();
    buffer.receive("11111111-1111-4111-8111-111111111111");
    buffer.receive("22222222-2222-4222-8222-222222222222");
    const listener = vi.fn();

    buffer.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("waits for an existing loading window before sending the activation", async () => {
    let resolveWindow!: () => void;
    const windowReady = new Promise<void>((resolve) => {
      resolveWindow = resolve;
    });
    const send = vi.fn();
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send },
    };
    const createWindow = vi.fn(() => windowReady);

    const activation = activateThreadNotification(
      "33333333-3333-4333-8333-333333333333",
      {
        channel: "inertia:thread-notification-activated",
        currentWindow: () => window,
        createWindow,
      },
    );

    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    resolveWindow();
    await activation;
    expect(send).toHaveBeenCalledWith(
      "inertia:thread-notification-activated",
      "33333333-3333-4333-8333-333333333333",
    );
  });
});
