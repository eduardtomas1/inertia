import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationDetailState } from "../../src/renderer/src/components/ConversationDetailState";

describe("conversation detail state", () => {
  it("states each missing or failed chat in one line, keeping a runtime message and the retry", () => {
    const { container, rerender } = render(<ConversationDetailState state="deleted" onRetry={vi.fn()} />);
    expect(container.querySelector("p")).toBeNull();
    expect(screen.getByRole("heading", { name: "This chat was deleted." })).toBeInTheDocument();
    rerender(<ConversationDetailState state="failed" message="Database is busy." onRetry={vi.fn()} />);
    expect(screen.getByText("Database is busy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
