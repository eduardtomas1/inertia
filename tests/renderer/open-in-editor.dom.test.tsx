import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";
import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";
import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { OpenInControl } from "../../src/renderer/src/components/workspace-header/OpenInControl";
import {
  EditorPreferenceContext,
  resetAvailableEditorsCacheForTests,
} from "../../src/renderer/src/hooks/useAvailableEditors";
import type { ContextMenuAction, ContextMenuRequest } from "../../src/shared/context-menu";
import { defaultSettings } from "../../src/shared/contracts";
import type { DetectedEditor } from "../../src/shared/editors";
import { settingsViewProps } from "./settings-view-fixtures";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const detected: DetectedEditor[] = [
  { id: "vscode", label: "VS Code" },
  { id: "zed", label: "Zed" },
];

const bridge = {
  showContextMenu: vi.fn<(request: ContextMenuRequest) => Promise<ContextMenuAction | null>>(),
  copyText: vi.fn(async () => true),
  openProjectPath: vi.fn(async () => ""),
  openExternal: vi.fn(async () => undefined),
  getAvailableEditors: vi.fn(async () => detected),
  getPlatform: () => "win32" as NodeJS.Platform,
  getAppHealth: vi.fn(async () => null),
};

const settleMenu = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resetAvailableEditorsCacheForTests();
  bridge.showContextMenu.mockResolvedValue(null);
  bridge.getAvailableEditors.mockResolvedValue(detected);
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "inertia");
});

describe("open in editor UI", () => {
  it("runs open-in-editor from file context menu and chat links with line numbers", async () => {
    const onOpenProjectFile = vi.fn();
    render(
      <EditorPreferenceContext.Provider value={{ preferredEditor: "vscode", detectedEditors: detected }}>
        <FilesPanel
          projectRoot="/work/project"
          projectId={projectId}
          conversationId={conversationId}
          entries={[{ path: "app.ts", kind: "file" }]}
          preview={null}
          selectedPath={null}
          onSelectFile={vi.fn()}
          onLoadEntries={vi.fn()}
        />
        <ResponseMarkdown
          content="See [app.ts:42](app.ts:42) and `app.ts:19:4`."
          projectRoot="/work/project"
          projectId={projectId}
          conversationId={conversationId}
          defaultCodeWrap={false}
          onOpenProjectFile={onOpenProjectFile}
        />
      </EditorPreferenceContext.Provider>,
    );

    const fileItem = within(screen.getByRole("tree", { name: "Files" })).getByRole("treeitem", { name: "app.ts" });
    bridge.showContextMenu.mockResolvedValueOnce("open-in-editor:vscode");
    fireEvent.contextMenu(fileItem, { clientX: 12, clientY: 16 });
    await settleMenu();

    const link = screen.getByRole("link", { name: "app.ts:42" });
    fireEvent.click(link);

    const chip = screen.getByRole("button", { name: "Open app.ts:19:4 in VS Code" });
    fireEvent.click(chip);

    expect(onOpenProjectFile).not.toHaveBeenCalled();
    expect(bridge.openProjectPath.mock.calls).toEqual([
      [{ projectId, conversationId, relativePath: "app.ts", action: "open-in-editor", editor: "vscode" }],
      [{ projectId, conversationId, relativePath: "app.ts", action: "open-in-editor", editor: "vscode", line: 42 }],
      [{ projectId, conversationId, relativePath: "app.ts", action: "open-in-editor", editor: "vscode", line: 19, column: 4 }],
    ]);
  });

  it("keeps existing Files panel behavior for chat links when preferred editor is system", () => {
    const onOpenProjectFile = vi.fn();
    render(
      <EditorPreferenceContext.Provider value={{ preferredEditor: "system", detectedEditors: detected }}>
        <ResponseMarkdown
          content="See [app.ts:42](app.ts:42)."
          projectRoot="/work/project"
          projectId={projectId}
          conversationId={conversationId}
          defaultCodeWrap={false}
          onOpenProjectFile={onOpenProjectFile}
        />
      </EditorPreferenceContext.Provider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "app.ts:42" }));
    expect(onOpenProjectFile).toHaveBeenCalledExactlyOnceWith("app.ts:42");
    expect(bridge.openProjectPath).not.toHaveBeenCalled();
  });

  it("opens the folder in the preferred editor from the workspace header control", async () => {
    const onOpenInEditor = vi.fn();
    render(
      <OpenInControl
        presentation="toolbar"
        checkoutName="Studio"
        checkoutPath="/studio"
        filesAvailable
        preferredEditor="vscode"
        detectedEditors={detected}
        onOpenFolder={vi.fn()}
        onRevealFolder={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenInEditor={onOpenInEditor}
      />,
    );

    const primary = screen.getByRole("button", { name: "Open Studio in VS Code" });
    fireEvent.click(primary);
    expect(onOpenInEditor).toHaveBeenCalledExactlyOnceWith("vscode");

    fireEvent.click(screen.getByRole("button", { name: "Choose where to open" }));
    const zedItem = await screen.findByRole("menuitem", { name: /^Zed/u });
    fireEvent.click(zedItem);
    expect(onOpenInEditor).toHaveBeenLastCalledWith("zed");
  });

  it("refreshes detected editors in Settings and persists the Preferred editor selection", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(
      <SettingsView
        {...settingsViewProps({
          target: { section: "chats" },
          settings: { ...defaultSettings, preferredEditor: "system" },
          onUpdate,
        })}
      />,
    );

    const select = await screen.findByRole("combobox", { name: "Preferred editor" });
    await waitFor(() => {
      const options = [...select.querySelectorAll("option")].map((option) => [option.value, option.textContent]);
      expect(options).toEqual([
        ["system", "System default"],
        ["ask", "Ask"],
        ["vscode", "VS Code"],
        ["zed", "Zed"],
      ]);
    });
    expect(bridge.getAvailableEditors).toHaveBeenCalledWith({ refresh: true });

    fireEvent.change(select, { target: { value: "zed" } });
    expect(onUpdate).toHaveBeenCalledWith({ preferredEditor: "zed" });
  });
});
