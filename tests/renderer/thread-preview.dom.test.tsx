import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadPreview } from "../../src/renderer/src/components/sidebar/useThreadPreview";
import { nativePreviewSuspended } from "../../src/renderer/src/utils/nativePreviewOverlay";
import { conversation } from "./composer-fixtures";

function Preview({ disabled = false }: { disabled?: boolean }) {
  const preview = useThreadPreview([conversation("First"), conversation("Second")], [], disabled);
  return <>{["First", "Second"].map((id) => <button key={id} onPointerEnter={(event) => preview.enter(id, event.currentTarget)}
    onPointerLeave={preview.leave}>{id}</button>)}{preview.preview}</>;
}
afterEach(() => vi.useRealTimers());
describe("delayed thread preview", () => {
  it("shows only the current hover after two seconds and supports entering and dismissing its surface", () => {
    vi.useFakeTimers();
    render(<Preview />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "First" }));
    act(() => { vi.advanceTimersByTime(1999); });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(nativePreviewSuspended()).toBe(false);
    fireEvent.pointerLeave(screen.getByRole("button", { name: "First" }));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Second" }));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Second");
    expect(nativePreviewSuspended()).toBe(true);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Project unavailable");
    fireEvent.pointerLeave(screen.getByRole("button", { name: "Second" }));
    fireEvent.pointerEnter(screen.getByRole("tooltip"));
    act(() => { vi.advanceTimersByTime(150); });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(nativePreviewSuspended()).toBe(false);
  });
  it.each(["leave", "disabled", "unmount"])("restores native preview when a visible card closes through %s", (reason) => {
    vi.useFakeTimers();
    const view = render(<Preview />);
    const trigger = screen.getByRole("button", { name: "First" });
    fireEvent.pointerEnter(trigger);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(nativePreviewSuspended()).toBe(true);
    if (reason === "leave") {
      fireEvent.pointerLeave(trigger);
      act(() => { vi.advanceTimersByTime(150); });
    } else if (reason === "disabled") view.rerender(<Preview disabled />);
    else view.unmount();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(nativePreviewSuspended()).toBe(false);
  });
  it("cancels pending previews when a context menu opens or the window loses focus", () => {
    vi.useFakeTimers();
    const view = render(<Preview />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "First" }));
    view.rerender(<Preview disabled />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    view.rerender(<Preview />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "First" }));
    fireEvent.blur(window);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
