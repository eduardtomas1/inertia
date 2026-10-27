import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewPanel, type PreviewPanelProps } from "../../src/renderer/src/components/PreviewPanel";
import { useDesktopTools } from "../../src/renderer/src/hooks/useDesktopTools";
import type { AgentBrowserViewport } from "../../src/shared/agent-browser";

const fit: AgentBrowserViewport = { width: 640, height: 420, fit: true, mobile: false, colorScheme: "system" };
const fixed = (width: number, height: number, mobile = false): AgentBrowserViewport => ({
  width, height, fit: false, mobile, colorScheme: "system",
});

function panel(props: Partial<PreviewPanelProps> = {}) {
  return (
    <PreviewPanel
      owner="primary"
      url="http://127.0.0.1:4173/one"
      onNavigate={vi.fn()}
      onOpenExternal={vi.fn()}
      onViewportChange={vi.fn()}
      {...props}
    />
  );
}

const viewportSelect = () => screen.getByRole("combobox", { name: "Viewport" }) as HTMLSelectElement;
const optionLabels = () => within(viewportSelect()).getAllByRole("option").map((option) => option.textContent);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser viewport control", () => {
  it("offers Fit and the three preset sizes in the chrome row", () => {
    const { container } = render(panel());
    const row = container.querySelector(".preview-chrome") as HTMLElement;
    expect(within(row).getByRole("combobox", { name: "Viewport" })).toBe(viewportSelect());
    expect(optionLabels()).toEqual(["Fit", "Desktop", "Tablet", "Mobile"]);
    expect(viewportSelect().value).toBe("fit");
  });

  it("selects the option that matches the published viewport", () => {
    const view = render(panel({ viewport: fit }));
    expect(viewportSelect().value).toBe("fit");
    view.rerender(panel({ viewport: fixed(1280, 800) }));
    expect(viewportSelect().value).toBe("desktop");
    view.rerender(panel({ viewport: fixed(768, 1024, true) }));
    expect(viewportSelect().value).toBe("tablet");
    view.rerender(panel({ viewport: fixed(375, 812, true) }));
    expect(viewportSelect().value).toBe("mobile");
    expect(optionLabels()).toHaveLength(4);
  });

  it("shows a size the agent chose as its own selected option", () => {
    const view = render(panel({ viewport: fixed(1440, 900) }));
    expect(optionLabels()).toEqual(["Fit", "Desktop", "Tablet", "Mobile", "1440×900"]);
    expect(viewportSelect().selectedOptions[0]).toHaveTextContent("1440×900");

    view.rerender(panel({ viewport: fixed(768, 1024) }));
    expect(viewportSelect().selectedOptions[0]).toHaveTextContent("768×1024");
    expect(optionLabels().at(-1)).toBe("768×1024");

    view.rerender(panel({ viewport: fixed(1280, 800) }));
    expect(optionLabels()).toHaveLength(4);
  });

  it("asks for the chosen preset and keeps showing the published viewport until it changes", () => {
    const onViewportChange = vi.fn();
    const view = render(panel({ viewport: fit, onViewportChange }));
    fireEvent.change(viewportSelect(), { target: { value: "desktop" } });
    fireEvent.change(viewportSelect(), { target: { value: "mobile" } });
    expect(onViewportChange.mock.calls).toEqual([[{ preset: "desktop" }], [{ preset: "mobile" }]]);
    expect(viewportSelect().value).toBe("fit");

    view.rerender(panel({ viewport: fixed(375, 812, true), onViewportChange }));
    fireEvent.change(viewportSelect(), { target: { value: "fit" } });
    expect(onViewportChange).toHaveBeenLastCalledWith({ preset: "fit" });
  });

  it("is reachable with Tab and changes with the keyboard", async () => {
    const user = userEvent.setup();
    const onViewportChange = vi.fn();
    render(panel({ viewport: fit, onViewportChange }));
    viewportSelect().closest(".preview-chrome")!.querySelector<HTMLButtonElement>("button[aria-label='Open in system browser']")!.focus();
    await user.tab();
    expect(viewportSelect()).toHaveFocus();
    await user.selectOptions(viewportSelect(), "tablet");
    expect(onViewportChange).toHaveBeenCalledExactlyOnceWith({ preset: "tablet" });
  });

  it("leaves the control out when no viewport handler is wired", () => {
    render(panel({ onViewportChange: undefined }));
    expect(screen.queryByRole("combobox", { name: "Viewport" })).toBeNull();
  });
});

describe("browser stage behind the native page", () => {
  it("draws only the stage under a local page", () => {
    render(panel({ url: "http://127.0.0.1:4173/one" }));
    const stage = screen.getByRole("tabpanel", { name: "Browser page" });
    expect(stage).toBeEmptyDOMElement();
    expect(screen.queryByText("This page loads outside the Inertia window.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open externally" })).toBeNull();
  });

  it("keeps the external address card for a page that cannot be embedded", () => {
    render(panel({ url: "https://example.com/docs" }));
    const stage = screen.getByRole("tabpanel", { name: "Browser page" });
    expect(within(stage).getByRole("heading", { name: "https://example.com" })).toBeInTheDocument();
    expect(within(stage).getByText("This page loads outside the Inertia window.")).toBeInTheDocument();
    expect(within(stage).getByRole("button", { name: "Open externally" })).toBeInTheDocument();
  });

  it("keeps the loading and empty states", () => {
    const view = render(panel({ loading: true }));
    expect(screen.getByText("Connecting to preview…")).toBeInTheDocument();
    view.rerender(panel({ url: "" }));
    expect(screen.getByRole("heading", { name: "Open a local preview" })).toBeInTheDocument();
  });
});

describe("browser viewport command", () => {
  it("sends the viewport request and shows the returned viewport", async () => {
    const desktop = fixed(1280, 800);
    const base = {
      url: "http://127.0.0.1:4173/one", loading: false, canGoBack: false, canGoForward: false,
      activeTabId: null, tabs: [], agentActivity: null,
      evidence: { revision: 0, entries: [], omitted: false },
    };
    const previewCommand = vi.fn(async () => ({ ...base, viewport: desktop }));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        previewClose: vi.fn(async () => undefined),
        previewConnect: vi.fn(async () => ({ ...base, viewport: fit })),
        previewCommand,
        onPreviewState: vi.fn(() => () => undefined),
      },
    });
    const hook = renderHook(() => useDesktopTools({
      setActionError: vi.fn(),
      previewOwnerId: "primary",
      previewContextId: "chat-one",
    }));
    await waitFor(() => expect(hook.result.current.previewNavigation.viewport).toEqual(fit));

    act(() => hook.result.current.previewCommand("viewport", { preset: "desktop" }));
    expect(previewCommand).toHaveBeenCalledExactlyOnceWith({
      ownerId: "primary", contextId: "chat-one", action: "viewport", viewport: { preset: "desktop" },
    });
    await waitFor(() => expect(hook.result.current.previewNavigation.viewport).toEqual(desktop));

    act(() => hook.result.current.previewCommand("reload"));
    expect(previewCommand).toHaveBeenLastCalledWith({ ownerId: "primary", contextId: "chat-one", action: "reload" });
  });
});
