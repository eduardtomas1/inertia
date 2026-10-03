import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReasoningSummary } from "../../src/renderer/src/components/response-timeline/activity";

afterEach(() => {
  document.body.replaceChildren();
});

describe("reasoning summary rendering", () => {
  it("renders concatenated bold headings as separate steps without raw markers", () => {
    const { container } = render(createElement(ReasoningSummary, {
      content:
        "**Clarifying network URLs**"
        + "**Researching public_url usage**"
        + "**Expanding search scope**",
    }));

    const steps = container.querySelectorAll(".turn-reasoning-step");
    expect(steps).toHaveLength(3);
    expect(
      [...container.querySelectorAll(".turn-reasoning-step-title")]
        .map((node) => node.textContent),
    ).toEqual([
      "Clarifying network URLs",
      "Researching public_url usage",
      "Expanding search scope",
    ]);
    expect(container.textContent).not.toContain("**");
  });

  it("falls back to a plain paragraph for unstructured reasoning", () => {
    const { container } = render(createElement(ReasoningSummary, {
      content: "Just thinking out loud.",
    }));
    expect(container.querySelector(".turn-reasoning-steps")).toBeNull();
    expect(container.querySelector(".turn-reasoning-body")?.textContent)
      .toBe("Just thinking out loud.");
  });
});
