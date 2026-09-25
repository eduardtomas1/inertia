import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { WorkspaceScene, type WorkspaceSceneProps, type WorkspaceToolScene } from "../../src/renderer/src/components/WorkspaceScene";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

vi.mock("../../src/renderer/src/components/ChatWorkspace", () => ({ ChatWorkspace: () => <div>Chat</div> }));
vi.mock("../../src/renderer/src/components/FilesPanel", () => ({ FilesPanel: () => <div>Project files</div> }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { fontSize: 13, theme: {} };
    loadAddon(): void {}
    open(container: HTMLElement): void { container.append(document.createElement("textarea")); }
    focus(): void {}
    onData(): { dispose: () => void } { return { dispose: () => undefined }; }
    clear(): void {}
    writeln(): void {}
    write(): void {}
    dispose(): void {}
  },
}));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} unobserve(): void {} });
});

it("moves multiple live terminals between the dock and surface without recreating or detaching them", async () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const ids = ["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442"];
  let sequence = 0;
  const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => {
    if (command.type === "terminal.create") return {
      type: "terminal.created", requestId: command.requestId, terminalId: ids[sequence++]!,
    };
    if (command.type === "terminal.attach") return {
      type: "terminal.created", requestId: command.requestId, terminalId: command.payload.terminalId,
    };
    return { type: "request.ok", requestId: command.requestId };
  });
  const terminal = {
    projectId, conversationId, projectName: "Project", status: "online" as const,
    fontSize: 13, theme: "dark" as const, sendCommand,
    subscribe: () => () => undefined, onClose: vi.fn(),
  };
  const noop = (): void => undefined;
  const scene = (active: "terminal" | "files", visible = true): React.JSX.Element => {
    const tools = {
      activeTool: active,
      panel: {
        surfaces: ["terminal", "files"], activeSurface: active, visible: true,
        onActivateSurface: noop, onOpenSurface: noop, onCloseSurface: noop,
      },
      terminal: { ...terminal, visible }, terminalKey: `${projectId}:${conversationId}`,
      files: {}, filesKey: "files",
    } as unknown as WorkspaceToolScene;
    return <StrictMode><WorkspaceScene view="workspace" settings={{} as WorkspaceSceneProps["settings"]}
      detailState={null} chat={{} as WorkspaceSceneProps["chat"]} resizeHandle={null} tools={tools} /></StrictMode>;
  };
  // Begin in the existing bottom dock, then move the same sessions to a surface.
  const view = render(scene("files"));
  await waitFor(() => expect(view.container.querySelectorAll('[data-terminal-state="ready"]')).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
  await waitFor(() => expect(view.container.querySelectorAll('[data-terminal-state="ready"]')).toHaveLength(2));
  const panels = [...view.container.querySelectorAll(".terminal-panel")];
  const activeTab = screen.getByRole("tab", { name: "Terminal 2" });
  expect(activeTab).toHaveAttribute("aria-selected", "true");
  sendCommand.mockClear();

  view.rerender(scene("terminal"));
  const surface = await screen.findByRole("tabpanel", { name: "Terminal" });
  await waitFor(() => expect(surface).toContainElement(panels[0] as HTMLElement));
  expect(view.container.querySelector(".terminal-dock")).not.toBeVisible();
  expect(surface).toContainElement(panels[1] as HTMLElement);
  expect(within(surface).getByRole("tab", { name: "Terminal 2" })).toBe(activeTab);
  expect(activeTab).toHaveAttribute("aria-selected", "true");

  activeTab.focus();
  view.rerender(scene("terminal"));
  expect(activeTab).toHaveFocus();
  view.rerender(scene("files", false));
  await screen.findByRole("tabpanel", { name: "Files" });
  expect(view.container.querySelector(".terminal-dock")).not.toBeVisible();
  view.rerender(scene("files"));
  const dock = view.container.querySelector(".terminal-dock");
  expect(dock).toBeVisible();
  expect(dock).toContainElement(panels[0] as HTMLElement);
  expect(dock).toContainElement(panels[1] as HTMLElement);
  expect(activeTab).toHaveAttribute("aria-selected", "true");
  expect(sendCommand.mock.calls.filter(([command]) =>
    ["terminal.create", "terminal.close", "terminal.detach", "terminal.attach"].includes(command.type),
  )).toEqual([]);
  expect(window.sessionStorage.getItem(`inertia:terminal-sessions:v1:${projectId}:${conversationId}`))
    .toBe(JSON.stringify(ids));
});
