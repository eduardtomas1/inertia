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

  it("draws the hover preview on the popover base without a kicker, heavy title or slide", () => {
    const preview = css.slice(css.indexOf(".timeline-minimap-preview {"), css.indexOf("}", css.indexOf(".timeline-minimap-preview {")));
    expect(preview).toContain("border-radius: var(--radius-sm)");
    expect(css).not.toContain('content: "Turn " attr(data-turn)');
    expect(css).toMatch(/\.timeline-minimap-preview > strong \{\n  font-size: var\(--text-sm\);\n  font-weight: 500;/u);
    expect(css).toMatch(/@keyframes timeline-minimap-preview-in \{\n  from \{\n    opacity: 0;\n  \}\n\}/u);
    expect(css).toMatch(/\.timeline-minimap button:focus-visible \{\n  outline: 2px solid var\(--focus-ring\);/u);
  });
});
