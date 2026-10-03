import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
).replace(/\r\n?/gu, "\n");

describe("timeline minimap presentation", () => {
  it("retains visible keyboard focus in forced colors", () => {
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.timeline-minimap button:focus-visible\s*\{[^}]*outline:\s*1px solid Highlight;/u);
  });
});
