import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SIDEBAR_AURORA_STEP_MS } from "../../src/renderer/src/components/sidebar/SidebarAurora";

const css = readFileSync(
  new URL("../../src/renderer/src/components/sidebar/sidebar-aurora.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//gu, "");

/** Top-level rules only; nested @keyframes/@media bodies are read separately. */
function block(selector: string, source = css): string {
  const topLevel = source.replace(/@(?:keyframes|media)[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/gu, "");
  for (const [, selectors, body] of topLevel.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (selectors!.trim() === selector) return body!;
  }
  throw new Error(`Missing rule: ${selector}`);
}

function declaration(body: string, property: string): string {
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`, "u").exec(body);
  if (!match) throw new Error(`Missing ${property}`);
  return match[1]!.trim();
}

describe("sidebar aurora", () => {
  it("leaves the layers paused for the coarse timer and stops them for reduced motion", () => {
    expect(declaration(block(".sidebar-aurora > span"), "animation-play-state")).toBe("paused");
    expect(declaration(block(".sidebar-aurora-glow"), "animation")).toMatch(/\bpaused$/u);
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/u.exec(css);
    expect(reduced).not.toBeNull();
    expect(declaration(block(".sidebar-aurora > span", reduced![1]!), "animation")).toBe("none");
    expect(SIDEBAR_AURORA_STEP_MS).toBeGreaterThanOrEqual(80);
    expect(SIDEBAR_AURORA_STEP_MS).toBeLessThanOrEqual(200);
  });
});
