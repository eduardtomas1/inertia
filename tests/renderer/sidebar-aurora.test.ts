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

  it("registers the work-state strengths so they cross-fade, and mixes them into every light", () => {
    expect(css).toMatch(/@property --aurora-boost \{\s*syntax: "<percentage>";\s*inherits: true;\s*initial-value: 0%;\s*\}/u);
    expect(css).toMatch(/@property --aurora-tint \{\s*syntax: "<percentage>";\s*inherits: true;\s*initial-value: 0%;\s*\}/u);
    expect(css).toContain("--aurora-2-live: color-mix(in srgb, var(--aurora-2), var(--status-approval) var(--aurora-tint));");
    expect(css).toContain("--aurora-mid-live: calc(var(--aurora-mid) + var(--aurora-boost));");
    expect(css).toContain("transition: --aurora-boost 1.2s var(--ease), --aurora-tint 1.2s var(--ease);");
    expect(declaration(block('.sidebar-aurora[data-activity="working"]'), "--aurora-boost")).toBe("4%");
    expect(declaration(block('.sidebar-aurora[data-activity="attention"]'), "--aurora-tint")).toBe("30%");
    expect(css).not.toMatch(/var\(--aurora-2\) var\(--aurora-(?:mid|wash)\)|var\(--aurora-mid\), transparent/u);
  });

  it("lays one static grain under the light that never animates", () => {
    const grain = block(".sidebar::before");
    expect(declaration(grain, "z-index")).toBe("-1");
    expect(declaration(grain, "pointer-events")).toBe("none");
    expect(declaration(grain, "mix-blend-mode")).toBe("soft-light");
    expect(declaration(grain, "opacity")).toBe("0.022");
    expect(declaration(block(':root[data-theme="dark"] .sidebar::before'), "opacity")).toBe("0.035");
    expect(grain).toContain("feTurbulence");
    expect(grain).not.toMatch(/animation|transition|will-change/u);
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.sidebar::before\s*\{\s*display: none;/u);
  });
});

