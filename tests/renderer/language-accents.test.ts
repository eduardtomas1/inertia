import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("language accent system", () => {
  it("uses one restrained semantic accent per family in both themes", () => {
    expect(css).toContain(
      '[data-language-family="java"] { --file-language-accent: var(--language-java); }',
    );
    for (const family of ["web", "script", "systems", "data", "markup"]) {
      expect(css).toContain(`[data-language-family="${family}"]`);
    }
    expect(css.match(/--language-java:/gu)).toHaveLength(2);
    expect(css).not.toMatch(/file-language[^{}]*animation:/u);
  });

  it("keeps forced-colors selection and labels system-controlled", () => {
    expect(css).toMatch(
      /@media \(forced-colors: active\)[\s\S]*?\[data-language-family\][\s\S]*?--file-language-accent: CanvasText;/u,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)[\s\S]*?\.file-preview-line\.is-referenced[\s\S]*?outline: 2px solid Highlight;/u,
    );
  });
});
