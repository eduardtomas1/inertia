import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelpGuide } from "../../src/renderer/src/components/welcome-guide/HelpGuide";
import { HELP_TOPICS } from "../../src/renderer/src/components/welcome-guide/helpTopics";
import { WelcomeGuide } from "../../src/renderer/src/components/welcome-guide/WelcomeGuide";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("guide transitions", () => {
  it("clears the help topic transition timer when the guide unmounts mid-transition", () => {
    const view = render(
      <HelpGuide
        shortcutLabel={(action) => action}
        onClose={vi.fn()}
        onCommand={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: HELP_TOPICS[1]!.title }));
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the welcome step transition timer when the guide unmounts mid-transition", () => {
    const view = render(
      <WelcomeGuide
        providers={[]}
        shortcuts={[]}
        onClose={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the leaving welcome step for its full transition after a rapid second move", () => {
    render(
      <WelcomeGuide
        providers={[]}
        shortcuts={[]}
        onClose={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );
    const leavingSteps = () => document.querySelectorAll(".welcome-guide-step.is-leaving").length;
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(leavingSteps()).toBe(1);
    act(() => { vi.advanceTimersByTime(199); });
    expect(leavingSteps()).toBe(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(leavingSteps()).toBe(0);
  });
});
