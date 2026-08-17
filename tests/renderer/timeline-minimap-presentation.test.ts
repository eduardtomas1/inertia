import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
).replace(/\r\n?/gu, "\n");

describe("timeline minimap presentation", () => {
  it("matches the Codex prompt rail line geometry", () => {
    expect(css).toMatch(/\.timeline-minimap\s*\{[^}]*width:\s*36px;/su);
    expect(css).toMatch(/\.timeline-minimap button\s*\{[^}]*width:\s*36px;[^}]*height:\s*10px;/su);
    expect(css).toMatch(/\.timeline-minimap button::before\s*\{[^}]*width:\s*calc\(6px \+ 20px \* var\(--timeline-marker-progress\)\);[^}]*height:\s*2px;/su);
  });

  it("uses the same restrained three-step neighboring emphasis", () => {
    expect(css).toContain("--timeline-marker-progress: 0.2;");
    expect(css).toContain("--timeline-marker-progress: 0.4;");
    expect(css).toContain("--timeline-marker-progress: 0.7;");
    expect(css).toContain("--timeline-marker-progress: 1;");
  });

  it("keeps the rail monochrome and free of a decorative container", () => {
    const start = css.indexOf(".timeline-minimap {");
    const end = css.indexOf(".response-turn > .message", start);
    const minimapCss = css.slice(start, end);
    expect(minimapCss).not.toContain(".timeline-minimap::before");
    expect(minimapCss).not.toContain("var(--accent)");
    expect(minimapCss).toContain("background: var(--text-soft);");
  });

  it("retains visible keyboard focus in forced colors", () => {
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.timeline-minimap button:focus-visible\s*\{[^}]*outline:\s*1px solid Highlight;/u);
  });
});
