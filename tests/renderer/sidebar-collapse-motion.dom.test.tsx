import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_COLLAPSE_MOTION_LIMIT_MS,
  useSidebarCollapseMotion,
} from "../../src/renderer/src/hooks/useSidebarCollapseMotion";

let reducedMotion: boolean;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  reducedMotion = false;
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion: no-preference") ? !reducedMotion : true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Shell({ collapsed, mobile = false }: { collapsed: boolean; mobile?: boolean }): React.JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null);
  const motion = useSidebarCollapseMotion(collapsed, mobile, shellRef);
  return (
    <div ref={shellRef} className="app-shell" data-sidebar-collapse={motion ?? undefined}>
      {(!collapsed || motion === "collapsing") && <aside className="sidebar" inert={motion === "collapsing" ? true : undefined} />}
    </div>
  );
}

function gridTransitionEnd(shell: Element): void {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: "grid-template-columns" });
  shell.dispatchEvent(event);
}

describe("sidebar collapse motion", () => {
  it("never animates the first paint or a resize", () => {
    const view = render(<Shell collapsed={false} />);
    expect(view.container.querySelector(".app-shell")).not.toHaveAttribute("data-sidebar-collapse");
  });

  it("keeps the collapsing sidebar inert until the column transition ends", () => {
    const view = render(<Shell collapsed={false} />);
    view.rerender(<Shell collapsed />);
    const shell = view.container.querySelector(".app-shell")!;
    expect(shell).toHaveAttribute("data-sidebar-collapse", "collapsing");
    expect(view.container.querySelector(".sidebar")).toHaveAttribute("inert");

    const sidebarFade = new Event("transitionend", { bubbles: true });
    Object.defineProperty(sidebarFade, "propertyName", { value: "opacity" });
    act(() => { view.container.querySelector(".sidebar")!.dispatchEvent(sidebarFade); });
    expect(shell).toHaveAttribute("data-sidebar-collapse", "collapsing");

    act(() => { gridTransitionEnd(shell); });
    expect(shell).not.toHaveAttribute("data-sidebar-collapse");
    expect(view.container.querySelector(".sidebar")).toBeNull();
  });

  it("marks an expansion and settles even when no transition event arrives", () => {
    const view = render(<Shell collapsed />);
    view.rerender(<Shell collapsed={false} />);
    const shell = view.container.querySelector(".app-shell")!;
    expect(shell).toHaveAttribute("data-sidebar-collapse", "expanding");
    expect(view.container.querySelector(".sidebar")).not.toHaveAttribute("inert");
    act(() => { vi.advanceTimersByTime(SIDEBAR_COLLAPSE_MOTION_LIMIT_MS); });
    expect(shell).not.toHaveAttribute("data-sidebar-collapse");
  });

  it("snaps as before for reduced motion, hidden windows and the mobile drawer", () => {
    reducedMotion = true;
    const view = render(<Shell collapsed={false} />);
    view.rerender(<Shell collapsed />);
    expect(view.container.querySelector(".app-shell")).not.toHaveAttribute("data-sidebar-collapse");
    expect(view.container.querySelector(".sidebar")).toBeNull();

    reducedMotion = false;
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    view.rerender(<Shell collapsed={false} />);
    expect(view.container.querySelector(".app-shell")).not.toHaveAttribute("data-sidebar-collapse");
    hidden.mockRestore();

    view.rerender(<Shell collapsed mobile />);
    expect(view.container.querySelector(".app-shell")).not.toHaveAttribute("data-sidebar-collapse");
  });
});
