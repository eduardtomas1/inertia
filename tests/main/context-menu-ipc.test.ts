import type { IpcMainInvokeEvent, MenuItemConstructorOptions, PopupOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopWindowContext } from "../../src/shared/desktop";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  build: vi.fn(),
  popup: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      electron.handlers.set(channel, handler);
    },
  },
  Menu: { buildFromTemplate: electron.build },
}));

import { registerContextMenuIpc } from "../../src/main/context-menu-ipc";

const channel = "inertia:show-context-menu";
const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversationId = "44444444-4444-4444-8444-444444444444";
const projectId = "33333333-3333-4333-8333-333333333333";
const anchor = { x: 100, y: 40 };

type Item = MenuItemConstructorOptions & { click?: () => void };

function fixture({
  context = { role: "main" } as DesktopWindowContext,
  packaged = true,
  platform = "darwin" as NodeJS.Platform,
  zoom = 1,
} = {}) {
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: { getZoomFactor: vi.fn(() => zoom), inspectElement: vi.fn() },
  };
  electron.fromWebContents.mockReturnValue(window);
  const assertTrusted = vi.fn((_event: IpcMainInvokeEvent, count: number, expected: number) => {
    if (count !== expected) throw new Error("Rejected untrusted renderer request");
    return context;
  });
  registerContextMenuIpc({ channel, assertTrusted, isPackaged: () => packaged, platform });
  const handler = electron.handlers.get(channel)!;
  const show = (...args: unknown[]) => handler({ sender: {} }, ...args);
  return { window, assertTrusted, show };
}

const template = () => electron.build.mock.calls.at(-1)![0] as Item[];
const shape = () => template().map((item) => (
  item.type === "separator" ? "-" : item.role ? `role:${item.role}` : item.enabled === false ? `${item.label} (disabled)` : item.label
));
const popupOptions = () => electron.popup.mock.calls.at(-1)![0] as PopupOptions;
const choose = (label: string) => template().find((item) => item.label === label)!.click!();
const dismiss = () => popupOptions().callback!();

beforeEach(() => {
  electron.handlers.clear();
  vi.clearAllMocks();
  electron.build.mockReturnValue({ popup: electron.popup });
});

describe("surface context menu IPC", () => {
  it.each([
    [
      "an assistant message with a selection",
      { kind: "message", conversationId, role: "assistant", hasSelection: true, anchor },
      ["role:copy", "-", "Copy Message", "Copy as Markdown"],
    ],
    [
      "a user message",
      { kind: "message", conversationId, role: "user", hasSelection: false, anchor },
      ["Copy Message"],
    ],
    ["a code block", { kind: "code", conversationId, hasSelection: false, anchor }, ["Copy Code"]],
    [
      "a project link",
      { kind: "project-link", projectId, conversationId, relativePath: "src/a.ts", anchor },
      ["Open", "Reveal in Finder", "-", "Copy Path", "Copy Relative Path"],
    ],
    [
      "a changed file",
      { kind: "diff-file", projectId, relativePath: "src/a.ts", anchor },
      ["Open", "Reveal in Finder", "-", "Copy Path", "Copy Relative Path"],
    ],
    [
      "a folder",
      { kind: "file", projectId, relativePath: "src", directory: true, anchor },
      ["Reveal in Finder", "-", "Copy Path", "Copy Relative Path"],
    ],
    [
      "a terminal without a selection",
      { kind: "terminal", hasSelection: false, clearable: true, anchor },
      ["Copy (disabled)", "role:paste", "Select All", "-", "Clear"],
    ],
    [
      "a sign-in terminal with a selection",
      { kind: "terminal", hasSelection: true, clearable: false, anchor },
      ["Copy", "role:paste", "Select All"],
    ],
  ])("builds the fixed items for %s", async (_name, request, expected) => {
    const { show } = fixture();
    const result = show(request);
    await vi.waitFor(() => expect(electron.popup).toHaveBeenCalledOnce());
    expect(shape()).toEqual(expected);
    dismiss();
    await expect(result).resolves.toBeNull();
  });

  it.each([
    ["win32", "Reveal in File Explorer"],
    ["linux", "Reveal in File Manager"],
  ] as const)("names the reveal action for %s", async (platform, label) => {
    const { show } = fixture({ platform });
    const result = show({ kind: "file", projectId, relativePath: "a.ts", directory: false, anchor });
    await vi.waitFor(() => expect(electron.popup).toHaveBeenCalledOnce());
    expect(shape()).toContain(label);
    choose(label);
    await expect(result).resolves.toBe("reveal");
  });

  it("resolves the chosen action even when the menu closes in the same turn", async () => {
    const { show } = fixture();
    const result = show({ kind: "message", conversationId, role: "assistant", hasSelection: false, anchor });
    await vi.waitFor(() => expect(electron.popup).toHaveBeenCalledOnce());
    dismiss();
    choose("Copy as Markdown");
    await expect(result).resolves.toBe("copy-markdown");
  });

  it("anchors the menu in window points under page zoom", async () => {
    const { window, show } = fixture({ zoom: 1.25 });
    void show({ kind: "code", hasSelection: false, anchor: { x: 101, y: 33 } });
    await vi.waitFor(() => expect(electron.popup).toHaveBeenCalledOnce());
    expect(popupOptions()).toMatchObject({ window, x: 126, y: 41 });
  });

  it("adds Inspect Element only to unpackaged builds", async () => {
    const packaged = fixture();
    void packaged.show({ kind: "code", hasSelection: false, anchor });
    await vi.waitFor(() => expect(electron.popup).toHaveBeenCalledOnce());
    expect(shape()).not.toContain("Inspect Element");

    electron.handlers.clear();
    const development = fixture({ packaged: false, zoom: 2 });
    const result = development.show({ kind: "code", hasSelection: false, anchor });
    await vi.waitFor(() => expect(electron.popup).toHaveBeenCalledTimes(2));
    expect(shape().slice(-2)).toEqual(["-", "Inspect Element"]);
    choose("Inspect Element");
    expect(development.window.webContents.inspectElement).toHaveBeenCalledWith(200, 80);
    dismiss();
    await expect(result).resolves.toBeNull();
  });

  it("rejects an untrusted sender before parsing or showing anything", async () => {
    const { assertTrusted, show } = fixture();
    assertTrusted.mockImplementation(() => { throw new Error("Rejected untrusted renderer request"); });
    await expect(show({ kind: "code", hasSelection: false, anchor })).rejects.toThrow("Rejected untrusted");
    expect(electron.build).not.toHaveBeenCalled();
  });

  it("rejects extra arguments and malformed requests", async () => {
    const { show } = fixture();
    await expect(show({ kind: "code", hasSelection: false, anchor }, "extra")).rejects.toThrow();
    await expect(show({ kind: "code", hasSelection: false, anchor, label: "Delete everything" }))
      .rejects.toThrow("Invalid context menu request");
    expect(electron.build).not.toHaveBeenCalled();
  });

  it("lets a detached chat show menus only for its own conversation", async () => {
    const context = {
      role: "detached-chat", conversationId, alwaysOnTop: false, draft: "",
    } as DesktopWindowContext;
    const { show } = fixture({ context });
    await expect(show({ kind: "message", conversationId: otherConversationId, role: "user", hasSelection: false, anchor }))
      .rejects.toThrow("owned conversation");
    await expect(show({ kind: "project-link", projectId, relativePath: "a.ts", anchor }))
      .rejects.toThrow("owned conversation");
    await expect(show({ kind: "terminal", hasSelection: false, clearable: true, anchor }))
      .rejects.toThrow("owned conversation");
    expect(electron.build).not.toHaveBeenCalled();
    const result = show({ kind: "message", conversationId, role: "user", hasSelection: false, anchor });
    await vi.waitFor(() => expect(electron.popup).toHaveBeenCalledOnce());
    choose("Copy Message");
    await expect(result).resolves.toBe("copy-message");
  });

  it("shows nothing when the sender has no live window", async () => {
    const { window, show } = fixture();
    window.isDestroyed.mockReturnValue(true);
    await expect(show({ kind: "code", hasSelection: false, anchor })).resolves.toBeNull();
    expect(electron.build).not.toHaveBeenCalled();
  });
});
