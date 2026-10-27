import { describe, expect, it, vi } from "vitest";

import { mainWindowTargetHandlers } from "../../src/main/main-window-targets";
import { DESKTOP_IPC } from "../../src/shared/desktop-ipc";
import { DETACHED_CHAT_IPC } from "../../src/shared/detached-chat-ipc";

const conversationId = "11111111-1111-4111-8111-111111111111";

function mainWindow(minimized = true) {
  const steps: string[] = [];
  const window = {
    minimized,
    isDestroyed: () => false,
    isMinimized: () => window.minimized,
    restore: vi.fn(() => {
      window.minimized = false;
      steps.push("restore");
    }),
    show: vi.fn(() => steps.push("show")),
    focus: vi.fn(() => steps.push("focus")),
    webContents: {
      send: vi.fn((channel: string, ...args: unknown[]) => {
        steps.push(`send:${channel}`);
        return args;
      }),
    },
  };
  return { window, steps };
}

describe("main-window targets from detached chats", () => {
  it("restores and focuses the main window before forwarding the exact target with its source chat", async () => {
    const { window, steps } = mainWindow();
    const createWindow = vi.fn(async () => {
      steps.push("create");
    });
    const handlers = mainWindowTargetHandlers({ currentWindow: () => window, createWindow });
    const target = { kind: "usage-limits" } as const;

    await handlers.onOpenInMainWindow(conversationId, target);

    expect(steps).toEqual([
      "create",
      "restore",
      "show",
      "focus",
      `send:${DETACHED_CHAT_IPC.mainWindowTarget}`,
    ]);
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(
      DETACHED_CHAT_IPC.mainWindowTarget,
      { sourceConversationId: conversationId, target },
    );
  });

  it("docks by activating the chat in the main window", async () => {
    const { window } = mainWindow(false);
    const handlers = mainWindowTargetHandlers({ currentWindow: () => window, createWindow: async () => undefined });

    await handlers.onDock(conversationId);

    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(
      DESKTOP_IPC.threadNotificationActivated,
      conversationId,
    );
  });

  it("fails without sending when the main window cannot be opened", async () => {
    const handlers = mainWindowTargetHandlers({ currentWindow: () => null, createWindow: async () => undefined });

    await expect(handlers.onOpenInMainWindow(conversationId, { kind: "diagnostics" }))
      .rejects.toThrow("The Inertia window could not be opened.");
  });
});
