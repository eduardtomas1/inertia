import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  useAnchoredDetailsToggle,
} from "../../src/renderer/src/components/response-timeline/activity";

function AnchoredDetails({ before, after }: {
  before: () => void;
  after: () => void;
}): React.JSX.Element {
  const handlers = useAnchoredDetailsToggle(before, after);
  return (
    <details>
      <summary {...handlers}>Execution transcript</summary>
      <p>Anchored detail</p>
    </details>
  );
}

describe("anchored disclosure lifecycle", () => {
  it("prepares once before a pointer toggle and settles after the next frame", async () => {
    const before = vi.fn();
    const after = vi.fn();
    render(<AnchoredDetails before={before} after={after} />);
    const summary = screen.getByText("Execution transcript");
    const details = summary.closest("details");

    summary.focus();
    fireEvent.keyDown(summary, { key: "Enter" });
    fireEvent.click(summary);

    expect(summary).toHaveFocus();
    expect(details).toHaveAttribute("open");
    expect(before).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(after).toHaveBeenCalledTimes(1));
    expect(before.mock.invocationCallOrder[0])
      .toBeLessThan(after.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });
});
