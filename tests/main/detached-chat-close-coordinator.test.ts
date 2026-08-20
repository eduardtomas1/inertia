import { EventEmitter } from "node:events";

import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeDetachedChatsForShutdown,
  coordinateMainWindowClose,
} from "../../src/main/detached-chat-close-coordinator";
import type { DetachedChatMain } from "../../src/main/detached-chat-main";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  closeCalls = 0;

  isDestroyed(): boolean { return this.destroyed; }

  close(): void {
    if (this.destroyed) return;
    this.closeCalls += 1;
    const event = {
      defaultPrevented: false,
      preventDefault(): void { this.defaultPrevented = true; },
    };
    this.emit("close", event);
    if (event.defaultPrevented) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

afterEach(() => vi.restoreAllMocks());

describe("detached chat close coordination", () => {
  it("defers main close once while detached renderers close gracefully", async () => {
    const closing = deferred();
    const detachedChats = {
      summaries: vi.fn(() => [{
        conversationId: "11111111-1111-4111-8111-111111111111",
        alwaysOnTop: false,
      }]),
      closeAll: vi.fn(() => closing.promise),
    } as unknown as DetachedChatMain;
    const window = new FakeWindow();
    const beforeClose = vi.fn();
    coordinateMainWindowClose(
      window as unknown as BrowserWindow,
      detachedChats,
      beforeClose,
    );

    window.close();
    window.close();
    expect(window.destroyed).toBe(false);
    expect(detachedChats.closeAll).toHaveBeenCalledOnce();

    closing.resolve();
    await vi.waitFor(() => expect(window.destroyed).toBe(true));
    expect(window.closeCalls).toBe(3);
    expect(beforeClose).toHaveBeenCalledTimes(3);
  });

  it("settles shutdown even when a detached close reports an error", async () => {
    const error = new Error("renderer did not close");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const detachedChats = {
      shutdown: vi.fn(async () => { throw error; }),
    } as unknown as DetachedChatMain;

    await expect(closeDetachedChatsForShutdown(detachedChats))
      .resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to close detached chats cleanly",
      error,
    );
  });
});
