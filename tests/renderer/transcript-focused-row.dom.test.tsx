import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { useViewportSyncedVirtualizer } from "../../src/renderer/src/components/response-timeline/useViewportSyncedVirtualizer";

function Transcript(): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [virtualizer] = useViewportSyncedVirtualizer<HTMLDivElement, HTMLElement>({
    count: 100,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 100,
    overscan: 2,
    initialRect: { width: 800, height: 300 },
    observeElementRect: (_instance, notify) => {
      notify({ width: 800, height: 300 });
      return () => undefined;
    },
  });
  return (
    <div ref={scrollRef} data-testid="transcript-scroll">
      <div style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((item) => (
          <article key={item.key} data-index={item.index} aria-label={`Row ${item.index}`}>
            <button type="button">Copy row {item.index}</button>
          </article>
        ))}
      </div>
    </div>
  );
}

function scrollTo(element: HTMLElement, top: number): void {
  element.scrollTop = top;
  element.dispatchEvent(new Event("scroll"));
}

describe("transcript virtualization focus", () => {
  it("keeps the row holding keyboard focus mounted while the reader scrolls away", async () => {
    render(<Transcript />);
    const copy = screen.getByRole("button", { name: "Copy row 1" });
    copy.focus();

    await act(async () => scrollTo(screen.getByTestId("transcript-scroll"), 5_000));

    expect(screen.getByRole("article", { name: "Row 50" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Row 10" })).toBeNull();
    expect(copy).toBeInTheDocument();
    expect(copy).toHaveFocus();
  });

  it("keeps rows in reading order when the focused row is below the viewport", async () => {
    render(<Transcript />);
    const scroll = screen.getByTestId("transcript-scroll");
    await act(async () => scrollTo(scroll, 5_000));
    const copy = screen.getByRole("button", { name: "Copy row 50" });
    copy.focus();

    await act(async () => scrollTo(scroll, 0));

    expect(copy).toHaveFocus();
    const order = screen.getAllByRole("article").map((row) => Number(row.dataset.index));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order.at(-1)).toBe(50);
    expect(order).toContain(0);
  });

  it("lets the row go once focus leaves it", async () => {
    render(<Transcript />);
    const copy = screen.getByRole("button", { name: "Copy row 1" });
    copy.focus();
    copy.blur();

    await act(async () => scrollTo(screen.getByTestId("transcript-scroll"), 5_000));

    expect(screen.queryByRole("article", { name: "Row 1" })).toBeNull();
  });
});
