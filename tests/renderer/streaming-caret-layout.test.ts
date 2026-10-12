import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("streaming caret layout", () => {
  it("streams without a pulsing caret", () => {
    expect(css).not.toMatch(/streaming-caret|is-streaming[^{]*::after|animation: pulse 900ms/u);
  });
});
