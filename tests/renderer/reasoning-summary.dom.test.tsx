import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReasoningSummary } from "../../src/renderer/src/components/response-timeline/activity";
import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
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

  it("keeps both turn work-log call sites on the step renderer", async () => {
    const source = await readFile(
      "src/renderer/src/components/response-timeline/activity.tsx",
      "utf8",
    );
    expect(source).toContain("<ReasoningSummary content={reasoningContent} />");
    expect(source).toMatch(
      /<ReasoningSummary\s+content=\{reasoningContent\}\s+streaming=\{activeReasoning\}\s*\/>/u,
    );
    expect(source).not.toMatch(/<p>\{reasoningContent\}/u);
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

describe("code frame copy control", () => {
  it("copies through the desktop bridge and reports the copied state", async () => {
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText },
    });

    render(createElement(ResponseMarkdown, {
      content: "```ts\nconst answer = 42;\n```",
      projectRoot: "/work/project",
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      defaultCodeWrap: false,
      streaming: false,
    }));

    fireEvent.click(screen.getByTitle("Copy code"));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(
      expect.stringContaining("const answer = 42;"),
    ));
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
  });
});
