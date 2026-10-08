import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";
import { CopyAnswerButton } from "../../src/renderer/src/components/response-timeline/metadata";

const answer = [
  "Hi Ana,",
  "",
  "> Ships on **Friday**.",
  "",
  "---",
  "",
  "| Item | Status |",
  "| --- | --- |",
  "| Export | Done |",
  "",
  "```sh",
  "npm run export",
  "```",
  "",
  "- See [the docs](https://example.com/docs)",
  "  - nested",
  "",
  "1. First",
  "2. Second",
].join("\n");

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
    render(<CopyAnswerButton content="Durable answer" answerId="answer-1" />);
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
    render(<CopyAnswerButton content="Uncopied answer" answerId="answer-1" />);
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

  it("copies the rendered answer as plain text when its article is mounted", async () => {
    const copyText = vi.fn(async (_text: string) => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText } as unknown as typeof window.inertia,
    });
    render(
      <section className="response-turn">
        <article data-terminal-answer-id="answer-0">
          <ResponseMarkdown content="Earlier answer" projectRoot="/workspace" projectId="11111111-1111-4111-8111-111111111111" defaultCodeWrap={false} />
        </article>
        <article data-terminal-answer-id="answer-1">
          <ResponseMarkdown content={answer} projectRoot="/workspace" projectId="11111111-1111-4111-8111-111111111111" defaultCodeWrap={false} />
        </article>
        <CopyAnswerButton content={answer} answerId="answer-1" />
      </section>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledOnce());
    const copied = copyText.mock.calls[0]![0];
    expect(copied).toBe([
      "Hi Ana,",
      "",
      "Ships on Friday.",
      "",
      "Item\tStatus",
      "Export\tDone",
      "",
      "npm run export",
      "",
      "- See the docs (https://example.com/docs)",
      "  - nested",
      "",
      "1. First",
      "2. Second",
    ].join("\n"));
    for (const marker of ["> ", "---", "|", "```", "**"]) {
      expect(copied).not.toContain(marker);
    }
  });

  it("copies the Markdown source when the answer is not mounted", async () => {
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText } as unknown as typeof window.inertia,
    });
    render(
      <section className="response-turn">
        <CopyAnswerButton content={answer} answerId="answer-1" />
      </section>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledExactlyOnceWith(answer));
  });
});
