import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IntroModule = typeof import("../../src/renderer/src/hooks/useLaunchIntro");

let intro: IntroModule;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.resetModules();
  intro = await import("../../src/renderer/src/hooks/useLaunchIntro");
});

afterEach(() => {
  vi.useRealTimers();
});

function Shell({ ready }: { ready: boolean }): React.JSX.Element {
  const active = intro.useLaunchIntro(ready);
  return <div className="app-shell" data-app-intro={active ? "" : undefined} />;
}

describe("launch intro", () => {
  it("plays from launch until the first work has had time to arrive", () => {
    const view = render(<Shell ready={false} />);
    const shell = view.container.querySelector(".app-shell")!;
    expect(shell).toHaveAttribute("data-app-intro");
    act(() => { vi.advanceTimersByTime(800); });
    view.rerender(<Shell ready />);
    act(() => { vi.advanceTimersByTime(intro.LAUNCH_INTRO_SETTLE_MS - 1); });
    expect(shell).toHaveAttribute("data-app-intro");
    act(() => { vi.advanceTimersByTime(1); });
    expect(shell).not.toHaveAttribute("data-app-intro");
  });

  it("gives up when the work never arrives and plays only once per launch", () => {
    const view = render(<Shell ready={false} />);
    act(() => { vi.advanceTimersByTime(intro.LAUNCH_INTRO_LIMIT_MS); });
    expect(view.container.querySelector(".app-shell")).not.toHaveAttribute("data-app-intro");
    view.unmount();
    const again = render(<Shell ready />);
    expect(again.container.querySelector(".app-shell")).not.toHaveAttribute("data-app-intro");
  });
});
