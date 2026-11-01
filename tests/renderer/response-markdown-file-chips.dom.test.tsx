import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseMarkdown } from "../../src/renderer/src/components/ResponseMarkdown";
import { FILE_CHIP_NOTICE_DURATION_MS } from "../../src/renderer/src/components/response-timeline/FileChip";
import { renderedAnswerText } from "../../src/renderer/src/utils/answerPlainText";
import { MAX_FILE_CHIPS_PER_DOCUMENT } from "../../src/renderer/src/utils/fileChipReference";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "inertia");
});

function fixture(
  content: string,
  options: { projectRoot?: string; fileChips?: boolean; withOpener?: boolean } = {},
) {
  const copyText = vi.fn(async (_text: string) => true);
  const openExternal = vi.fn(async (_url: string) => undefined);
  const openProjectPath = vi.fn(async () => undefined);
  const showContextMenu = vi.fn();
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { copyText, openExternal, openProjectPath, showContextMenu },
  });
  const onOpenProjectFile = vi.fn();
  const result = render(
    <ResponseMarkdown
      content={content}
      projectRoot={options.projectRoot ?? "/workspace/project"}
      projectId={PROJECT_ID}
      conversationId={CONVERSATION_ID}
      defaultCodeWrap={false}
      {...(options.fileChips === undefined ? {} : { fileChips: options.fileChips })}
      {...(options.withOpener === false ? {} : { onOpenProjectFile })}
    />,
  );
  return { ...result, copyText, openExternal, openProjectPath, onOpenProjectFile };
}

function chip(token: string): HTMLButtonElement {
  return screen.getByRole("button", { name: `Open ${token} in Files` });
}

describe("file chips in response Markdown", () => {
  it("renders inline-code paths as chips with an icon, basename, line and folder hint", () => {
    const { container } = fixture("Edit `src/renderer/src/App.tsx:42` next.");
    const button = chip("src/renderer/src/App.tsx:42");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("response-file-chip");
    expect(button).toHaveAttribute("title", "src/renderer/src/App.tsx:42");
    expect(button).toHaveAttribute("data-file-chip-kind", "code");
    expect(button.tagName).toBe("BUTTON");
    expect(button.closest("a")).toBeNull();
    const parts = [...button.children];
    expect(parts.map((part) => part.getAttribute("class"))).toEqual([
      expect.stringContaining("response-file-chip-icon"),
      "response-file-chip-name",
      "response-file-chip-line",
      "response-file-chip-folder",
      "visually-hidden response-file-chip-text",
    ]);
    const icon = parts[0]!;
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon).toHaveAttribute("width", "14");
    expect(icon).toHaveAttribute("height", "14");
    for (const visual of parts.slice(0, 4)) expect(visual).toHaveAttribute("aria-hidden", "true");
    expect(parts[1]).toHaveTextContent(/^App\.tsx$/u);
    expect(parts[2]).toHaveTextContent(/^:42$/u);
    expect(parts[3]).toHaveTextContent(/^src\/renderer\/src$/u);
    expect(parts[4]).toHaveTextContent(/^src\/renderer\/src\/App\.tsx:42$/u);
    expect(parts[4]).not.toHaveAttribute("aria-hidden");
    expect(container.querySelector(".response-markdown code")).toBeNull();
  });

  it("chooses the icon by file type and leaves names without a known extension as code", () => {
    const { container } = fixture(
      "`a/app.ts` `a/notes.md` `a/logo.png` `a/config.yml` `a/folder` `a/data.bin`",
    );
    expect([...container.querySelectorAll(".response-file-chip")].map(
      (element) => element.getAttribute("data-file-chip-kind"),
    )).toEqual(["code", "text", "image", "config"]);
    const icons = [...container.querySelectorAll(".response-file-chip-icon")]
      .map((icon) => icon.getAttribute("class"));
    expect(new Set(icons).size).toBe(4);
    expect([...container.querySelectorAll("p > code")].map((code) => code.textContent))
      .toEqual(["a/folder", "a/data.bin"]);
  });

  it("copies the whole token, path and line, when the reader selects across a chip", () => {
    const { container } = fixture("Edit `src/renderer/src/App.tsx:42` next.");
    const paragraph = container.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toContain("src/renderer/src/App.tsx:42");
    selection.removeAllRanges();

    const css = readFileSync(
      "src/renderer/src/components/response-timeline/FileChip.css",
      "utf8",
    ).replace(/\r\n?/gu, "\n");
    expect(css).toContain(".response-markdown .response-file-chip > :not(.response-file-chip-text) {\n  user-select: none;\n}");
    expect(css).toContain(".response-markdown .response-file-chip-text {\n  user-select: text;\n}");
    const chipButton = chip("src/renderer/src/App.tsx:42");
    for (const visual of chipButton.querySelectorAll(":scope > :not(.response-file-chip-text)")) {
      expect(visual.matches(".response-file-chip > :not(.response-file-chip-text)")).toBe(true);
    }
    expect(chipButton.querySelectorAll(".response-file-chip-text")).toHaveLength(1);
    expect(chipButton).toHaveAttribute("data-file-chip-text", "src/renderer/src/App.tsx:42");
  });

  it("omits the folder hint for a bare basename and the line when none is given", () => {
    fixture("Read `package.json`.");
    const button = chip("package.json");
    expect(button.querySelector(".response-file-chip-folder")).toBeNull();
    expect(button.querySelector(".response-file-chip-line")).toBeNull();
    expect(button.querySelector(".response-file-chip-name")).toHaveTextContent("package.json");
  });

  it("middle-truncates a long folder hint and keeps the full path in the title", () => {
    const token = "src/renderer/src/components/response-timeline/nested/deeper/FileChip.tsx:9:4";
    fixture(`See \`${token}\`.`);
    const button = chip(token);
    const folder = button.querySelector(".response-file-chip-folder")!;
    expect(folder.textContent).toBe("src/renderer/src/co…meline/nested/deeper");
    expect(Array.from(folder.textContent ?? "")).toHaveLength(40);
    expect(button.querySelector(".response-file-chip-line")).toHaveTextContent(":9:4");
    expect(button).toHaveAttribute("title", token);
  });

  it("opens the project file at the line and column", () => {
    const { onOpenProjectFile } = fixture("`src/app.ts:12:3` and `./src/util.ts` and `src\\main\\index.ts:5`");
    fireEvent.click(chip("src/app.ts:12:3"));
    expect(onOpenProjectFile).toHaveBeenLastCalledWith(
      "src/app.ts",
      { startLine: 12, startColumn: 3, endLine: 12 },
    );
    fireEvent.click(chip("./src/util.ts"));
    expect(onOpenProjectFile).toHaveBeenLastCalledWith("src/util.ts");
    expect(onOpenProjectFile.mock.lastCall).toHaveLength(1);
    fireEvent.click(chip("src\\main\\index.ts:5"));
    expect(onOpenProjectFile).toHaveBeenLastCalledWith(
      "src/main/index.ts",
      { startLine: 5, endLine: 5 },
    );
  });

  it("resolves an absolute path inside the project through the workspace containment rules", () => {
    const { onOpenProjectFile, openExternal } = fixture("`/workspace/project/src/app.ts:7`");
    fireEvent.click(chip("/workspace/project/src/app.ts:7"));
    expect(onOpenProjectFile).toHaveBeenCalledWith("src/app.ts", { startLine: 7, endLine: 7 });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("activates from the keyboard with Enter and Space", async () => {
    const user = userEvent.setup();
    const { onOpenProjectFile } = fixture("`src/app.ts:4`");
    const button = chip("src/app.ts:4");
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onOpenProjectFile).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onOpenProjectFile).toHaveBeenCalledTimes(2);
    expect(onOpenProjectFile).toHaveBeenLastCalledWith("src/app.ts", { startLine: 4, endLine: 4 });
  });

  function expectPlainCode(container: HTMLElement, token: string): void {
    expect(container.querySelector(".response-file-chip")).toBeNull();
    expect(screen.queryByRole("button", { name: `Open ${token} in Files` })).toBeNull();
    expect(screen.queryByLabelText(/in Files$/u)).toBeNull();
    const code = container.querySelector("p > code");
    expect(code).toHaveTextContent(token);
    expect(code?.attributes).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  }

  it("renders a path outside the workspace as plain code, with no chip and no notice", () => {
    const { container, onOpenProjectFile, openExternal, openProjectPath } = fixture("`/elsewhere/app.ts`");
    expectPlainCode(container, "/elsewhere/app.ts");
    fireEvent.click(container.querySelector("p > code")!);
    expect(onOpenProjectFile).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(openProjectPath).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders paths as plain code when the chat has no workspace", () => {
    const { container } = fixture("`src/app.ts`", { projectRoot: "" });
    expectPlainCode(container, "src/app.ts");
  });

  it("renders paths as plain code when no file opener is available", () => {
    const { container } = fixture("`src/app.ts`", { withOpener: false });
    expectPlainCode(container, "src/app.ts");
  });

  it("shows the notice only when the opener reports that it could not open the file", () => {
    vi.useFakeTimers();
    const opener = vi.fn((): boolean => false);
    render(
      <ResponseMarkdown
        content="`src/app.ts` and `src/gone.ts` and `src/broken.ts`"
        projectRoot="/workspace/project"
        projectId={PROJECT_ID}
        conversationId={CONVERSATION_ID}
        defaultCodeWrap={false}
        onOpenProjectFile={opener}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    const button = chip("src/app.ts");
    fireEvent.click(button);
    expect(screen.getByRole("alert")).toHaveTextContent("Not in this workspace");
    expect(chip("src/app.ts")).toBe(button);
    act(() => { vi.advanceTimersByTime(FILE_CHIP_NOTICE_DURATION_MS); });
    expect(screen.queryByRole("alert")).toBeNull();

    opener.mockImplementationOnce(() => {
      throw new Error("Files is closed");
    });
    fireEvent.click(chip("src/broken.ts"));
    expect(screen.getByRole("alert")).toHaveTextContent("Not in this workspace");
    act(() => { vi.advanceTimersByTime(FILE_CHIP_NOTICE_DURATION_MS); });
    expect(screen.queryByRole("alert")).toBeNull();

    opener.mockImplementationOnce(() => true);
    fireEvent.click(chip("src/gone.ts"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(opener).toHaveBeenCalledTimes(3);
  });

  it("chips paths inside headings, blockquotes and table cells", () => {
    const { container, onOpenProjectFile } = fixture([
      "## Changes in `src/app.ts`",
      "",
      "> Read `docs/guide.md:3` first.",
      "",
      "| File | Why |",
      "| --- | --- |",
      "| `src/parser.ts` | Tokens |",
    ].join("\n"));
    expect(container.querySelector("h2 .response-file-chip")).toHaveAttribute("data-file-chip-text", "src/app.ts");
    expect(container.querySelector("blockquote .response-file-chip")).toHaveAttribute("data-file-chip-text", "docs/guide.md:3");
    expect(container.querySelector("td .response-file-chip")).toHaveAttribute("data-file-chip-text", "src/parser.ts");
    fireEvent.click(chip("src/parser.ts"));
    expect(onOpenProjectFile).toHaveBeenLastCalledWith("src/parser.ts");
    fireEvent.click(chip("docs/guide.md:3"));
    expect(onOpenProjectFile).toHaveBeenLastCalledWith("docs/guide.md", { startLine: 3, endLine: 3 });
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
  ])("copies the path on %s-click and announces it", async (_label, modifiers) => {
    const { copyText, onOpenProjectFile } = fixture("`src/app.ts:12`");
    fireEvent.click(chip("src/app.ts:12"), modifiers);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("src/app.ts:12"));
    expect(await screen.findByRole("status")).toHaveTextContent("Path copied to clipboard.");
    expect(onOpenProjectFile).not.toHaveBeenCalled();
  });

  it("copies the path on middle-click without opening it", async () => {
    const { copyText, onOpenProjectFile } = fixture("`src/app.ts`");
    const button = chip("src/app.ts");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent(button, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("src/app.ts"));
    expect(await screen.findByRole("status")).toHaveTextContent("Path copied to clipboard.");
    expect(onOpenProjectFile).not.toHaveBeenCalled();
  });

  it("reports a failed copy with the shared copy failure notice", async () => {
    const { copyText } = fixture("`src/app.ts`");
    copyText.mockResolvedValueOnce(false);
    fireEvent.click(chip("src/app.ts"), { ctrlKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't copy.");
  });

  it("keeps non-path inline code plain", () => {
    const { container } = fixture([
      "`npm run build`",
      "`https://example.com/app.ts`",
      "`C:\\Users\\me\\app.ts`",
      "`~/app.ts`",
      "`../secret.env`",
      "`src/components/`",
      "`--config=app.json`",
      "`const value = 1`",
      "`README`",
      `\`${"a/".repeat(99)}x.ts\``,
      "`application/json`",
      "`@types/node`",
      "`origin/main`",
      "`/api/users`",
      "`src/renderer`",
      "`Node.js`",
      "`2026-10-31`",
    ].join(" "));
    expect(container.querySelector(".response-file-chip")).toBeNull();
    const codes = [...container.querySelectorAll("p > code")].map((code) => code.textContent);
    expect(codes).toHaveLength(17);
    expect(codes[0]).toBe("npm run build");
    expect(codes[2]).toBe("C:\\Users\\me\\app.ts");
    expect(container.querySelector("p > code")?.attributes).toHaveLength(0);
  });

  it("never renders chips in fenced code blocks, links or summaries", () => {
    const { container } = fixture([
      "```ts",
      "import { app } from \"src/app.ts\";",
      "```",
      "",
      "    src/indented.ts",
      "",
      "[`src/linked.ts`](https://example.com/linked)",
      "",
      "<details><summary><code>src/summary.ts</code></summary><p>Body <code>src/body.ts</code></p></details>",
    ].join("\n"));
    const chips = [...container.querySelectorAll(".response-file-chip")]
      .map((element) => element.getAttribute("data-file-chip-text"));
    expect(chips).toEqual(["src/body.ts"]);
    expect(container.querySelector("pre")).toHaveTextContent("src/app.ts");
    expect(container.querySelector("a code")).toHaveTextContent("src/linked.ts");
    expect(container.querySelector("summary code")).toHaveTextContent("src/summary.ts");
  });

  it("caps chips per message and renders the rest as plain inline code", () => {
    const tokens = Array.from(
      { length: MAX_FILE_CHIPS_PER_DOCUMENT + 3 },
      (_, index) => `\`src/file-${index}.ts\``,
    );
    const { container } = fixture(tokens.join(" "));
    const chips = container.querySelectorAll(".response-file-chip");
    expect(chips).toHaveLength(MAX_FILE_CHIPS_PER_DOCUMENT);
    expect(chips[chips.length - 1]).toHaveAttribute(
      "data-file-chip-text",
      `src/file-${MAX_FILE_CHIPS_PER_DOCUMENT - 1}.ts`,
    );
    expect([...container.querySelectorAll("p > code")].map((code) => code.textContent)).toEqual([
      `src/file-${MAX_FILE_CHIPS_PER_DOCUMENT}.ts`,
      `src/file-${MAX_FILE_CHIPS_PER_DOCUMENT + 1}.ts`,
      `src/file-${MAX_FILE_CHIPS_PER_DOCUMENT + 2}.ts`,
    ]);
  });

  it("renders hostile path text as text without interpreting it", () => {
    const { container } = fixture("<code>src/&lt;img src=x onerror=alert(1)&gt;.ts</code> `src/$(rm).ts`");
    expect(container.querySelector("img")).toBeNull();
    const button = chip("src/$(rm).ts");
    expect(button.querySelector(".response-file-chip-name")?.childNodes).toHaveLength(1);
    expect(button.querySelector(".response-file-chip-name")?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(button.getAttribute("href")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps the full path in copied answer text", () => {
    const { container } = fixture("Change `src/app.ts:12` and `README.md`.");
    expect(renderedAnswerText(container, "fallback")).toBe("Change src/app.ts:12 and README.md.");
  });

  it("can be turned off for repository Markdown previews", () => {
    const { container } = fixture("`src/app.ts`", { fileChips: false });
    expect(container.querySelector(".response-file-chip")).toBeNull();
    expect(container.querySelector("p > code")).toHaveTextContent("src/app.ts");
    expect(container.querySelector("p > code")?.attributes).toHaveLength(0);
  });

  it("styles the chip through theme tokens only, so light and dark follow the palette", () => {
    const css = readFileSync(
      "src/renderer/src/components/response-timeline/FileChip.css",
      "utf8",
    ).replace(/\r\n?/gu, "\n");
    const block = (selector: string): string => {
      const start = css.indexOf(`${selector} {\n`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf("\n}", start));
    };
    const base = block(".response-markdown .response-file-chip");
    expect(base).toContain("display: inline-flex;");
    expect(base).toContain("align-items: baseline;");
    expect(base).toContain("white-space: nowrap;");
    expect(base).toContain("border: 1px solid var(--line-soft);");
    expect(base).toContain("border-radius: var(--radius-xs);");
    expect(base).toContain("background: var(--fill);");
    expect(base).not.toContain("outline");
    expect(block(".response-markdown .response-file-chip:hover")).toContain("background: var(--fill-strong);");
    expect(block(".response-markdown .response-file-chip-name")).toContain("font-weight: 500;");
    const folder = block(".response-markdown .response-file-chip-folder");
    expect(folder).toContain("font-size: var(--text-xs);");
    expect(folder).toContain("color: var(--text-muted);");
    expect(block(".response-markdown .response-file-chip-line")).toContain("color: var(--text-muted);");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/iu);
    expect(css).not.toMatch(/focus/u);
    const colorTokens = [...css.matchAll(/(?:color|background|border):[^;]*var\((--[\w-]+)\)/gu)]
      .map((match) => match[1]);
    expect(new Set(colorTokens)).toEqual(new Set(["--line-soft", "--text", "--fill", "--fill-strong", "--text-muted"]));
    const root = readFileSync("src/renderer/src/styles.css", "utf8");
    const darkStart = root.indexOf(':root[data-theme="dark"] {');
    const dark = root.slice(darkStart, root.indexOf("\n}", darkStart));
    expect(dark).toMatch(/--text: #[0-9a-f]{6};/iu);
    expect(dark).toMatch(/--text-muted: #[0-9a-f]{6};/iu);
    for (const derived of ["--fill", "--fill-strong", "--line-soft"]) {
      expect(root).toMatch(new RegExp(`${derived}: color-mix\\(in srgb, var\\(--text\\) \\d+%, transparent\\);`, "u"));
    }
  });
});
