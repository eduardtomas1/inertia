import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserWindow, Rectangle, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DetachedChatWindowManager,
  type DetachedChatWindowFactoryInput,
} from "../../src/main/detached-chat-window-manager";
import { DetachedChatWindowStateStore } from "../../src/main/detached-chat-window-state";

function conversationId(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

class FakeWebContents extends EventEmitter {
  destroyed = false;
  readonly sent: Array<{ channel: string; args: unknown[] }> = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }
}

class FakeBrowserWindow extends EventEmitter {
  readonly contents = new FakeWebContents();
  destroyed = false;
  rejectDestroyedWebContentsAccess = false;
  minimized = false;
  focused = false;
  visible = false;
  maximized = false;
  fullscreen = false;
  alwaysOnTop = false;
  preventClose = false;
  title = "";
  closeCalls = 0;
  destroyCalls = 0;
  restoreCalls = 0;
  bounds: Rectangle;
  normalBounds: Rectangle;

  constructor(bounds: Rectangle) {
    super();
    this.bounds = { ...bounds };
    this.normalBounds = { ...bounds };
  }

  get webContents(): FakeWebContents {
    if (this.destroyed && this.rejectDestroyedWebContentsAccess) {
      throw new TypeError("Object has been destroyed");
    }
    return this.contents;
  }

  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return this.minimized; }
  isFocused(): boolean { return this.focused; }
  isMaximized(): boolean { return this.maximized; }
  isFullScreen(): boolean { return this.fullscreen; }
  isAlwaysOnTop(): boolean { return this.alwaysOnTop; }
  getBounds(): Rectangle { return { ...this.bounds }; }
  getNormalBounds(): Rectangle { return { ...this.normalBounds }; }
  setTitle(title: string): void { this.title = title; }
  setAlwaysOnTop(value: boolean): void { this.alwaysOnTop = value; }
  show(): void { this.visible = true; }
  focus(): void { this.focused = true; }
  restore(): void { this.minimized = false; this.restoreCalls += 1; }

  close(): void {
    if (this.destroyed) return;
    this.closeCalls += 1;
    const event = {
      defaultPrevented: false,
      preventDefault(): void { this.defaultPrevented = true; },
    };
    this.emit("close", event);
    if (this.preventClose || event.defaultPrevented) return;
    this.destroyed = true;
    this.contents.destroyed = true;
    this.emit("closed");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyCalls += 1;
    this.destroyed = true;
    this.contents.destroyed = true;
    this.emit("closed");
  }
}

interface ManagerFixture {
  directory: string;
  manager: DetachedChatWindowManager;
  state: DetachedChatWindowStateStore;
  windows: FakeBrowserWindow[];
  inputs: DetachedChatWindowFactoryInput[];
  changed: ReturnType<typeof vi.fn>;
  rendererGone: ReturnType<typeof vi.fn>;
}

function managerFixture(options: {
  directory?: string;
  loadWindow?: (window: BrowserWindow) => Promise<void>;
  onRendererGone?: (conversationId: string) => void;
} = {}): ManagerFixture {
  const directory = options.directory
    ?? mkdtempSync(join(tmpdir(), "inertia-detached-manager-"));
  const state = new DetachedChatWindowStateStore(
    join(directory, "detached-chat-window-state.json"),
  );
  const windows: FakeBrowserWindow[] = [];
  const inputs: DetachedChatWindowFactoryInput[] = [];
  const changed = vi.fn();
  const rendererGone = vi.fn(options.onRendererGone ?? (() => undefined));
  const manager = new DetachedChatWindowManager({
    createWindow: (input) => {
      inputs.push(input);
      const window = new FakeBrowserWindow({
        x: input.bounds.x ?? 80,
        y: input.bounds.y ?? 80,
        width: input.bounds.width,
        height: input.bounds.height,
      });
      windows.push(window);
      return window as unknown as BrowserWindow;
    },
    loadWindow: options.loadWindow ?? (async () => undefined),
    getDisplays: () => [{
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }],
    state,
    onWindowsChanged: changed,
    onRendererGone: rendererGone,
  });
  return { directory, manager, state, windows, inputs, changed, rendererGone };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("detached chat window manager", () => {
  it("opens one native owner per chat, focuses duplicates, and caps ownership", async () => {
    const fixture = managerFixture();
    try {
      const first = await fixture.manager.open({
        conversationId: conversationId(1),
        title: "First chat",
      });
      expect(first).toEqual({
        disposition: "opened",
        conversationId: conversationId(1),
        alwaysOnTop: false,
      });
      fixture.windows[0]!.minimized = true;
      const duplicate = await fixture.manager.open({
        conversationId: conversationId(1),
        title: "Renamed chat",
      });
      expect(duplicate.disposition).toBe("focused");
      expect(fixture.windows).toHaveLength(1);
      expect(fixture.windows[0]!.restoreCalls).toBe(1);
      expect(fixture.windows[0]!.title).toBe("Renamed chat — Inertia");
      expect(fixture.manager.isFocused(conversationId(1))).toBe(true);

      for (let index = 2; index <= 8; index += 1) {
        await fixture.manager.open({
          conversationId: conversationId(index),
          title: `Chat ${index}`,
        });
      }
      await expect(fixture.manager.open({
        conversationId: conversationId(9),
        title: "Ninth chat",
      })).rejects.toThrow("No more than 8 detached chats");
      expect(fixture.manager.summary()).toHaveLength(8);
    } finally {
      await fixture.manager.closeAll();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("binds context, pin, title updates, and close operations to the exact sender", async () => {
    const fixture = managerFixture();
    try {
      await fixture.manager.open({
        conversationId: conversationId(1),
        title: "First chat",
      });
      await fixture.manager.open({
        conversationId: conversationId(2),
        title: "Second chat",
      });
      const sender = fixture.windows[0]!.webContents as unknown as WebContents;
      const foreign = new FakeWebContents() as unknown as WebContents;

      expect(fixture.manager.contextForSender(sender)).toEqual({
        role: "detached-chat",
        conversationId: conversationId(1),
        alwaysOnTop: false,
      });
      expect(fixture.manager.setAlwaysOnTopForSender(sender, true)).toEqual({
        conversationId: conversationId(1),
        alwaysOnTop: true,
      });
      expect(fixture.manager.retargetForSender(sender, {
        conversationId: conversationId(1),
        title: "Renamed chat",
      })).toEqual({
        conversationId: conversationId(1),
        alwaysOnTop: true,
      });
      expect(fixture.windows[0]!.title).toBe("Renamed chat — Inertia");
      expect(fixture.manager.windowForConversation(conversationId(1)))
        .not.toBeNull();
      expect(() => fixture.manager.retargetForSender(sender, {
        conversationId: conversationId(3),
        title: "Different chat",
      })).toThrow("cannot change chats");
      expect(() => fixture.manager.contextForSender(foreign))
        .toThrow("Rejected untrusted detached-chat renderer");

      fixture.windows[0]!.rejectDestroyedWebContentsAccess = true;
      expect(() => fixture.manager.closeForSender(sender)).not.toThrow();
      expect(fixture.manager.summary().map(({ conversationId }) => conversationId))
        .toEqual([conversationId(2)]);
    } finally {
      await fixture.manager.closeAll();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("persists normal bounds per conversation but never restores open ownership", async () => {
    vi.useFakeTimers();
    const fixture = managerFixture();
    const id = conversationId(1);
    try {
      await fixture.manager.open({ conversationId: id, title: "Sized chat" });
      const window = fixture.windows[0]!;
      window.bounds = { x: 210, y: 160, width: 710, height: 830 };
      window.emit("move");
      await vi.advanceTimersByTimeAsync(300);
      expect(fixture.state.snapshot().windows).toContainEqual({
        conversationId: id,
        bounds: { x: 210, y: 160, width: 710, height: 830 },
      });
      window.normalBounds = { ...window.bounds };
      window.fullscreen = true;
      window.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
      await fixture.manager.closeAll();

      const restored = managerFixture({ directory: fixture.directory });
      expect(restored.manager.summary()).toEqual([]);
      await restored.manager.open({ conversationId: id, title: "Sized chat" });
      expect(restored.inputs[0]!.bounds).toEqual({
        x: 210,
        y: 160,
        width: 710,
        height: 830,
      });
      await restored.manager.closeAll();
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("registers authority before load and cleans failed renderers", async () => {
    let inspectDuringLoad: (() => void) | null = null;
    const fixture = managerFixture({
      loadWindow: async () => {
        inspectDuringLoad?.();
        throw new Error("renderer failed");
      },
    });
    try {
      inspectDuringLoad = () => {
        const sender = fixture.windows[0]!.webContents as unknown as WebContents;
        expect(fixture.manager.contextForSender(sender)).toMatchObject({
          role: "detached-chat",
          conversationId: conversationId(1),
        });
      };
      await expect(fixture.manager.open({
        conversationId: conversationId(1),
        title: "Failed chat",
      })).rejects.toThrow("renderer failed");
      expect(fixture.manager.summary()).toEqual([]);
      expect(fixture.windows[0]!.destroyed).toBe(true);
    } finally {
      await fixture.manager.closeAll();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("broadcasts only to live detached renderers", async () => {
    const fixture = managerFixture();
    try {
      await fixture.manager.open({
        conversationId: conversationId(1),
        title: "First chat",
      });
      await fixture.manager.open({
        conversationId: conversationId(2),
        title: "Second chat",
      });
      fixture.manager.sendToAll("inertia:runtime-ready", { generation: 2 });
      for (const window of fixture.windows) {
        expect(window.webContents.sent).toEqual([{
          channel: "inertia:runtime-ready",
          args: [{ generation: 2 }],
        }]);
      }
      fixture.manager.close(conversationId(1));
      fixture.manager.broadcast("inertia:theme", "dark");
      expect(fixture.windows[0]!.webContents.sent).toHaveLength(1);
      expect(fixture.windows[1]!.webContents.sent.at(-1)).toEqual({
        channel: "inertia:theme",
        args: ["dark"],
      });
    } finally {
      await fixture.manager.closeAll();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("closes renderers gracefully and destroys only after the timeout", async () => {
    vi.useFakeTimers();
    const fixture = managerFixture();
    try {
      await fixture.manager.open({
        conversationId: conversationId(1),
        title: "Graceful chat",
      });
      await fixture.manager.open({
        conversationId: conversationId(2),
        title: "Stuck chat",
      });
      const graceful = fixture.windows[0]!;
      const stuck = fixture.windows[1]!;
      stuck.preventClose = true;

      const closing = fixture.manager.closeAll(50);
      expect(fixture.manager.closeAll(50)).toBe(closing);
      expect(graceful.closeCalls).toBe(1);
      expect(graceful.destroyCalls).toBe(0);
      expect(stuck.closeCalls).toBe(1);
      expect(stuck.destroyed).toBe(false);
      await expect(fixture.manager.open({
        conversationId: conversationId(3),
        title: "Too late",
      })).rejects.toThrow("windows are closing");

      await vi.advanceTimersByTimeAsync(50);
      await closing;
      expect(stuck.destroyCalls).toBe(1);
      expect(fixture.manager.summary()).toEqual([]);
    } finally {
      await fixture.manager.closeAll();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("recovers crash handling after a renderer cancels native close", async () => {
    const fixture = managerFixture();
    try {
      await fixture.manager.open({
        conversationId: conversationId(1),
        title: "Blocked close",
      });
      const window = fixture.windows[0]!;
      window.preventClose = true;
      window.close();
      window.contents.emit("will-prevent-unload");
      window.contents.emit("render-process-gone");

      expect(fixture.rendererGone).toHaveBeenCalledWith(conversationId(1));
      expect(window.destroyCalls).toBe(1);
      expect(fixture.manager.summary()).toEqual([]);
    } finally {
      await fixture.manager.closeAll();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
