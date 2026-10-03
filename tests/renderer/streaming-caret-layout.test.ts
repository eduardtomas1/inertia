import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("streaming caret layout", () => {
  it("pauses the live caret while the window is hidden", () => {
    expect(css).toMatch(
      /data-document-visible="false"[\s\S]*?response-markdown\.is-streaming[\s\S]*?animation-play-state:\s*paused/u,
    );
  });
});
