import { readFileSync } from "node:fs";

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

  it("keeps the Copy icon and shows a visible failure when the clipboard rejects the write", async () => {
    const copyText = vi.fn(async () => false);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText } as unknown as typeof window.inertia,
    });
    render(<CopyAnswerButton content="Uncopied answer" />);
    const copy = screen.getByRole("button", { name: "Copy answer" });
    fireEvent.click(copy);

    await waitFor(() => expect(copyText).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Copy failed" }))
      .toBe(copy);
    expect(copy.querySelector("[data-icon-state]"))
      .toHaveAttribute("data-icon-state", "copy");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Couldn't copy. Try again or select the text manually.");
    expect(copy).toHaveTextContent("Copy failed");
  });

  it("keeps the Copy icon when narrow windows hide its label", () => {
    const css = readFileSync("src/renderer/src/styles.css", "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "");
    const hidden: string[] = [];
    for (const start of [...css.matchAll(/@media \(max-width: 760px\) \{/gu)].map((match) => match.index! + match[0].length)) {
      let depth = 1;
      let end = start;
      while (depth > 0) {
        if (css[end] === "{") depth += 1;
        if (css[end] === "}") depth -= 1;
        end += 1;
      }
      for (const [, selectors, body] of css.slice(start, end - 1).matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        if (/display:\s*none/u.test(body!)) hidden.push(selectors!.trim());
      }
    }
    const view = render(<CopyAnswerButton content="Narrow answer" />);
    const copy = screen.getByRole("button", { name: "Copy answer" });
    const icon = copy.querySelector(".inertia-morph-icon")!;
    const label = [...copy.children].find((child) => child.textContent === "Copy")!;
    const matched = hidden.flatMap((selector) => [...view.container.querySelectorAll(selector)]);
    expect(matched).toContain(label);
    expect(matched).not.toContain(icon);
  });
});

