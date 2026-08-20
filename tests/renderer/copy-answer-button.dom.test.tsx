import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyAnswerButton } from "../../src/renderer/src/components/response-timeline/metadata";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("final answer copy feedback", () => {
  it("morphs Copy to Check only after the clipboard confirms success", async () => {
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText } as unknown as typeof window.inertia,
    });
    render(<CopyAnswerButton content="Durable answer" />);
    const copy = screen.getByRole("button", { name: "Copy answer" });
    expect(copy.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "copy");

    fireEvent.click(copy);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("Durable answer"));
    const copied = screen.getByRole("button", { name: "answer copied" });
    expect(copied.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "copied");
    expect(screen.getByRole("status")).toHaveTextContent("Answer copied.");
  });

  it("keeps the Copy icon when the clipboard rejects the write", async () => {
    const copyText = vi.fn(async () => false);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText } as unknown as typeof window.inertia,
    });
    render(<CopyAnswerButton content="Uncopied answer" />);
    const copy = screen.getByRole("button", { name: "Copy answer" });
    fireEvent.click(copy);

    await waitFor(() => expect(copyText).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Copy answer" }))
      .toBe(copy);
    expect(copy.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "copy");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
