import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");

describe("Minimal Workstream conversation canvas", () => {
  it("animates the overlay sheet only when reduced motion is not requested", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.workspace-body > \.workspace-panel\.is-sheet:not\(\[hidden\]\)\s*\{[^}]*animation:/su,
    );
  });
});
