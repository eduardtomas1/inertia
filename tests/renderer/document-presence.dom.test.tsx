import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDocumentPresence } from "../../src/renderer/src/hooks/useDocumentPresence";
import { LiveElapsed } from "../../src/renderer/src/components/response-timeline/activity";

function PresenceHarness({ onRender }: { onRender: () => void }) {
  onRender();
  const presence = useDocumentPresence();
  return (
    <output
      data-active={presence > 1}
      data-visible={presence > 0}
    />
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("document presence", () => {
  it("keeps visible blur distinct from hidden rendering with one render per real transition", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    let focused = true;
    vi.spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const onRender = vi.fn();
    const view = render(<PresenceHarness onRender={onRender} />);
    const output = view.getByRole("status");

    expect(output).toHaveAttribute("data-active", "true");
    expect(output).toHaveAttribute("data-visible", "true");
    expect(onRender).toHaveBeenCalledTimes(1);

    focused = false;
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(output).toHaveAttribute("data-active", "false");
    expect(output).toHaveAttribute("data-visible", "true");
    expect(onRender).toHaveBeenCalledTimes(2);

    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(onRender).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(output).toHaveAttribute("data-active", "false");
    expect(output).toHaveAttribute("data-visible", "false");
    expect(onRender).toHaveBeenCalledTimes(3);

    focused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onRender).toHaveBeenCalledTimes(3);

    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(output).toHaveAttribute("data-active", "true");
    expect(output).toHaveAttribute("data-visible", "true");
    expect(onRender).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates visible elapsed work at most once per second and stops while hidden", async () => {
    vi.useFakeTimers();
    const startedAt = "2026-08-19T08:00:00.000Z";
    vi.setSystemTime(new Date(startedAt));
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const view = render(<LiveElapsed startedAt={startedAt} />);

    expect(view.getByText("0.0s")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(999));
    expect(view.getByText("0.0s")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(1));
    expect(view.getByText("1.0s")).toBeInTheDocument();

    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(view.getByText("1.0s")).toBeInTheDocument();

    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(view.getByText("3.0s")).toBeInTheDocument();
  });

  it("keeps persisted suspend time out of the live work clock", async () => {
    vi.useFakeTimers();
    const startedAt = "2026-08-19T08:00:00.000Z";
    vi.setSystemTime(new Date("2026-08-19T08:00:10.000Z"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(
      <LiveElapsed startedAt={startedAt} excludedMs={7_000} />,
    );

    expect(view.getByText("3.0s")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(999));
    expect(view.getByText("3.0s")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(1));
    expect(view.getByText("4.0s")).toBeInTheDocument();

    view.rerender(<LiveElapsed startedAt={startedAt} excludedMs={9_000} />);
    expect(view.getByText("2.0s")).toBeInTheDocument();
  });
});
