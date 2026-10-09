import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PreviewPanel, type PreviewPanelProps } from "../../src/renderer/src/components/PreviewPanel";

const page = (id: string, title: string) => ({ id, title, url: `http://127.0.0.1:4173/${id}`, loading: false });

function panel(props: Partial<PreviewPanelProps> = {}) {
  return (
    <PreviewPanel
      owner="primary"
      url="http://127.0.0.1:4173/one"
      tabs={[page("one", "One")]}
      activeTabId="one"
      onNavigate={vi.fn()}
      onOpenExternal={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onReload={vi.fn()}
      onOpenTab={vi.fn()}
      onActivateTab={vi.fn()}
      onCloseTab={vi.fn()}
      {...props}
    />
  );
}

describe("browser chrome", () => {
  it("puts every browser control in one row without a Go button or Browser label", () => {
    const { container } = render(panel());
    const rows = container.querySelectorAll(".preview-chrome");
    expect(rows).toHaveLength(1);
    const row = within(rows[0] as HTMLElement);
    for (const name of ["Go back", "Go forward", "Reload preview", "Open in system browser", "Evidence 0", "Open browser page"]) {
      expect(row.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(row.getByRole("textbox", { name: "Preview address" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go" })).toBeNull();
    expect(screen.queryByText("Browser")).toBeNull();
    expect(screen.queryByText("Evidence")).toBeNull();
  });

  it("navigates when Enter submits the address", () => {
    const onNavigate = vi.fn();
    render(panel({ onNavigate }));
    const address = screen.getByRole("textbox", { name: "Preview address" });
    fireEvent.change(address, { target: { value: "localhost:5173/app" } });
    fireEvent.submit(address.closest("form")!);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("http://localhost:5173/app");
  });

  it("shows an address error as one alert line", () => {
    render(panel({ url: "" }));
    const address = screen.getByRole("textbox", { name: "Preview address" });
    fireEvent.change(address, { target: { value: "ftp://example.com" } });
    fireEvent.submit(address.closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("Only HTTP and HTTPS addresses can be previewed.");
    expect(address).toHaveAttribute("aria-invalid", "true");
  });

  it("shows the page strip only with two or more pages", () => {
    const view = render(panel());
    expect(screen.queryByRole("tablist", { name: "Browser pages" })).toBeNull();
    view.rerender(panel({ tabs: [page("one", "One"), page("two", "Two")] }));
    const strip = screen.getByRole("tablist", { name: "Browser pages" });
    expect(within(strip).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["One", "Two"]);
    expect(within(strip).getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "true");
    expect(within(strip).getByRole("button", { name: "Close Two" }).closest(".panel-tab")).not.toBeNull();
  });

  it("draws a loading bar along the seam while a page loads", () => {
    const { container, rerender } = render(panel({ loading: true }));
    expect(container.querySelector(".preview-chrome > .preview-loading-bar")).not.toBeNull();
    rerender(panel({ loading: false }));
    expect(container.querySelector(".preview-loading-bar")).toBeNull();
  });

  it("scrolls the page strip with the wheel and fades the edge that hides pages", () => {
    render(panel({ tabs: [page("one", "One"), page("two", "Two"), page("three", "Three")] }));
    const strip = screen.getByRole("tablist", { name: "Browser pages" });
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 300 });
    fireEvent.wheel(strip, { deltaY: 60 });
    expect(strip.scrollLeft).toBe(60);
    fireEvent.scroll(strip);
    expect(strip).toHaveAttribute("data-overflow-start");
    expect(strip).toHaveAttribute("data-overflow-end");
  });
});
