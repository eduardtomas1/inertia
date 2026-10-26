import { describe, expect, it } from "vitest";

import {
  splitStreamingMarkdown,
  streamingMarkdownTail,
  type StreamingMarkdownSplit,
} from "../../src/renderer/src/utils/streamingMarkdownSplit";

function streamed(chunks: readonly string[]): StreamingMarkdownSplit {
  let split: StreamingMarkdownSplit | undefined;
  let content = "";
  for (const chunk of chunks) {
    content += chunk;
    split = splitStreamingMarkdown(content, split);
  }
  return split!;
}

describe("streaming Markdown split", () => {
  it("settles every paragraph closed by a blank line and keeps the growing one as the tail", () => {
    const split = splitStreamingMarkdown("## Plan\n\nFirst **bold** line\nsecond line\n\n\nStill typ");
    expect(split.blocks).toEqual(["## Plan", "First **bold** line\nsecond line"]);
    expect(streamingMarkdownTail(split)).toBe("Still typ");
  });

  it("keeps a single paragraph entirely in the tail", () => {
    const split = splitStreamingMarkdown("Only one paragraph so far");
    expect(split.blocks).toEqual([]);
    expect(streamingMarkdownTail(split)).toBe("Only one paragraph so far");
  });

  it("never splits inside an unclosed fence, even across blank lines", () => {
    const split = splitStreamingMarkdown("Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n");
    expect(split.blocks).toEqual(["Intro"]);
    expect(streamingMarkdownTail(split)).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n");
    expect(split.fence).toBe("```");
  });

  it("settles a fenced block only once the fence closes and a blank line follows", () => {
    const content = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    const split = splitStreamingMarkdown(content);
    expect(split.blocks).toEqual(["Intro", "```ts\nconst a = 1;\n\nconst b = 2;\n```"]);
    expect(streamingMarkdownTail(split)).toBe("After");
  });

  it("requires a matching closer of the same character and at least the opener length", () => {
    const split = splitStreamingMarkdown("````md\n```\nnested\n```\n\nstill code\n````\n\nDone");
    expect(split.blocks).toEqual(["````md\n```\nnested\n```\n\nstill code\n````"]);
    expect(streamingMarkdownTail(split)).toBe("Done");
    expect(splitStreamingMarkdown("~~~\ncode\n```\n\nmore").blocks).toEqual([]);
  });

  it("produces the same result incrementally as in one pass, whatever the chunking", () => {
    const content = "# Title\n\nA paragraph with `code`.\n\n```js\nlet x;\n\nx = 1;\n```\n\n- one\n- two\n\nTail text";
    const whole = splitStreamingMarkdown(content);
    for (const size of [1, 2, 3, 7, 13]) {
      const chunks = Array.from({ length: Math.ceil(content.length / size) }, (_, index) =>
        content.slice(index * size, (index + 1) * size));
      const incremental = streamed(chunks);
      expect(incremental.blocks).toEqual(whole.blocks);
      expect(streamingMarkdownTail(incremental)).toBe(streamingMarkdownTail(whole));
    }
  });

  it("reuses the settled blocks array while only the tail grows", () => {
    const first = splitStreamingMarkdown("One\n\nTwo");
    const second = splitStreamingMarkdown("One\n\nTwo more", first);
    expect(second.blocks).toBe(first.blocks);
    expect(splitStreamingMarkdown("One\n\nTwo more", second)).toBe(second);
  });

  it("starts over when the content is replaced instead of extended", () => {
    const first = splitStreamingMarkdown("Old one\n\nOld two");
    const replaced = splitStreamingMarkdown("New\n\nText", first);
    expect(replaced.blocks).toEqual(["New"]);
    expect(streamingMarkdownTail(replaced)).toBe("Text");
  });

  it("keeps an indented fence inside a list item whole across blank lines", () => {
    const content = "1. Install\n\n    ```bash\n    npm ci\n\n    npm test\n    ```\n\n2. Run\n\nDone";
    const split = splitStreamingMarkdown(content);
    expect(split.blocks).toEqual(["1. Install\n\n    ```bash\n    npm ci\n\n    npm test\n    ```\n\n2. Run"]);
    expect(streamingMarkdownTail(split)).toBe("Done");
    expect(splitStreamingMarkdown("- Step\n\n   ```\n   a\n\n   b\n").fence).toBe("```");
  });

  it("keeps indented continuations and loose list items with their list", () => {
    const split = splitStreamingMarkdown("- **First**\n\n  More about it\n\n- Second\n\nAfter the list\n\nTail");
    expect(split.blocks).toEqual(["- **First**\n\n  More about it\n\n- Second", "After the list"]);
    expect(streamingMarkdownTail(split)).toBe("Tail");
    expect(splitStreamingMarkdown("Intro\n\n    indented code\n\nNext").blocks)
      .toEqual(["Intro\n\n    indented code"]);
  });

  it("waits for a whole list marker before settling a list", () => {
    expect(splitStreamingMarkdown("1. One\n\n2").blocks).toEqual([]);
    expect(splitStreamingMarkdown("1. One\n\n2. Two\n\nAfter").blocks).toEqual(["1. One\n\n2. Two"]);
    expect(splitStreamingMarkdown("- One\n\nWord").blocks).toEqual(["- One"]);
  });

  it("keeps a raw HTML block whole until its closing tag", () => {
    const content = "<details>\n<summary>Log</summary>\n\nbody\n\n<details>\ninner\n\n</details>\n\nstill\n</details>\n\nAfter";
    const split = splitStreamingMarkdown(content);
    expect(split.blocks).toEqual(["<details>\n<summary>Log</summary>\n\nbody\n\n<details>\ninner\n\n</details>\n\nstill\n</details>"]);
    expect(streamingMarkdownTail(split)).toBe("After");
    expect(splitStreamingMarkdown("<kbd>Ctrl</kbd> first\n\nSecond").blocks).toEqual(["<kbd>Ctrl</kbd> first"]);
  });

  it("matches one pass for lists, indented fences and HTML whatever the chunking", () => {
    const content = "- a\n\n  ```\n  x\n\n  y\n  ```\n\n- b\n\n<div>\n\nz\n\n</div>\n\n1. c\n\n2. d\n\nEnd";
    const whole = splitStreamingMarkdown(content);
    for (const size of [1, 2, 3, 5, 11]) {
      const chunks = Array.from({ length: Math.ceil(content.length / size) }, (_, index) =>
        content.slice(index * size, (index + 1) * size));
      const incremental = streamed(chunks);
      expect(incremental.blocks).toEqual(whole.blocks);
      expect(streamingMarkdownTail(incremental)).toBe(streamingMarkdownTail(whole));
    }
  });

  it("starts over when the first character of a pending line is replaced", () => {
    const first = splitStreamingMarkdown("Intro\n\nNext");
    expect(first.blocks).toEqual(["Intro"]);
    const replaced = splitStreamingMarkdown("Intro\n\n  indented", first);
    expect(replaced.blocks).toEqual([]);
    expect(streamingMarkdownTail(replaced)).toBe("Intro\n\n  indented");
  });

  it("treats CRLF line endings like LF", () => {
    const split = splitStreamingMarkdown("One\r\n\r\n```\r\na\r\n\r\nb\r\n```\r\n\r\nTwo");
    expect(split.blocks).toEqual(["One", "```\r\na\r\n\r\nb\r\n```"]);
    expect(streamingMarkdownTail(split)).toBe("Two");
  });
});
