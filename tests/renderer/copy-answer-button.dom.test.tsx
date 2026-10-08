import { readFileSync } from "node:fs";

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

async function renderedCopyOf(content: string): Promise<string> {
  const copyText = vi.fn(async (_text: string) => true);
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { copyText } as unknown as typeof window.inertia,
  });
  const view = render(
    <section className="response-turn">
      <article data-terminal-answer-id="answer-1">
        <ResponseMarkdown content={content} projectRoot="/workspace" projectId="11111111-1111-4111-8111-111111111111" defaultCodeWrap={false} />
      </article>
      <CopyAnswerButton content={content} answerId="answer-1" />
    </section>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
  await waitFor(() => expect(copyText).toHaveBeenCalledOnce());
  view.unmount();
  return copyText.mock.calls[0]![0];
}

describe("final answer plain text copy", () => {
  it.each([
    ["task list states", "- [x] done\n- [ ] todo", "- [x] done\n- [ ] todo"],
    ["external image", "![Diagram](https://example.com/d.png)", "Diagram (https://example.com/d.png)"],
    ["project image", "![Chart](chart.png)", "Chart (chart.png)"],
    ["image without alt text", "![](https://example.com/d.png)", "https://example.com/d.png"],
    ["project link", "Edit [main](src/main.ts) now", "Edit main (src/main.ts) now"],
    ["project link named by its path", "Edit [src/main.ts](src/main.ts) now", "Edit src/main.ts now"],
    ["local file link", "Read [the log](file:///tmp/app.log)", "Read the log (/tmp/app.log)"],
    ["www autolink", "See www.example.com now.", "See www.example.com now."],
    ["bare autolink", "See https://example.com for details.", "See https://example.com for details."],
    ["loose list continuation", "1. first\n\n   second para\n\n2. next", "1. first\n   second para\n2. next"],
    ["nested list under a loose item", "- first\n\n  more\n\n  - nested\n\n- next", "- first\n  more\n  - nested\n- next"],
    ["table opening with an empty cell", "|  | A |\n| --- | --- |\n| x | 1 |", "\tA\nx\t1"],
    ["table ending with an empty cell", "| a | b |\n| --- | --- |\n|  | x |\n| y |  |", "a\tb\n\tx\ny\t"],
  ])("keeps %s", async (_name, content, expected) => {
    const copied = await renderedCopyOf(content);
    expect(copied).toBe(expected);
    for (const marker of ["> ", "---", "|", "```", "**", "image unavailable", "image waiting to load"]) {
      expect(copied).not.toContain(marker);
    }
  });
});

describe("final answer selection copy", () => {
  it("keeps the quote bar and interface labels out of a selected answer", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("src/renderer/src/styles.css", "utf8");
    document.head.append(style);
    const { container } = render(
      <>
        <article className="message is-assistant turn-final-answer-document is-final-answer">
          <header className="final-answer-identity"><span>GPT-5.6</span></header>
          <ResponseMarkdown content={answer} projectRoot="/workspace" projectId="11111111-1111-4111-8111-111111111111" defaultCodeWrap={false} />
        </article>
        <ResponseMarkdown content="> Earlier quote" projectRoot="/workspace" projectId="11111111-1111-4111-8111-111111111111" defaultCodeWrap={false} />
      </>,
    );

    const quotes = [...container.querySelectorAll("blockquote")];
    expect(quotes).toHaveLength(2);
    const rules = [...style.sheet!.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    for (const quote of quotes) {
      expect(getComputedStyle(quote).borderLeftWidth).toBe("");
      expect(rules.filter((rule) => quote.matches(rule.selectorText) && /border-left|border:/u.test(rule.style.cssText)))
        .toEqual([]);
    }
    for (const selector of [".final-answer-identity", ".response-table-toolbar", ".response-code-block > header"]) {
      expect(getComputedStyle(container.querySelector(selector)!).userSelect).toBe("none");
    }
    style.remove();
  });
});
