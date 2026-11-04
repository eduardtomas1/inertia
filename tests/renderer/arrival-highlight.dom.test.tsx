import { afterEach, describe, expect, it, vi } from "vitest";

import { highlightArrivalOnFocus } from "../../src/renderer/src/utils/arrivalHighlight";

function article(attribute: string, id: string): HTMLElement {
  const element = document.createElement("article");
  element.setAttribute(attribute, id);
  element.tabIndex = -1;
  document.body.append(element);
  return element;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("arrival highlight", () => {
  it("marks the answer that navigation focuses and clears the mark after a moment", () => {
    vi.useFakeTimers();
    const other = article("data-terminal-answer-id", "other");
    const answer = article("data-terminal-answer-id", "answer");
    highlightArrivalOnFocus("answer");

    other.focus();
    expect(other).not.toHaveAttribute("data-arrival");
    answer.focus();
    expect(answer).toHaveAttribute("data-arrival", "");

    vi.advanceTimersByTime(2_000);
    expect(answer).not.toHaveAttribute("data-arrival");
    other.focus();
    answer.focus();
    expect(answer).not.toHaveAttribute("data-arrival");
  });

  it("gives up when the destination never takes focus", () => {
    vi.useFakeTimers();
    const request = article("data-message-search-id", "request");
    highlightArrivalOnFocus("request");
    vi.advanceTimersByTime(6_500);
    request.focus();
    expect(request).not.toHaveAttribute("data-arrival");
  });
});
