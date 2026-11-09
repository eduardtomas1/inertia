import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SIDEBAR_AURORA_STEP_MS } from "../../src/renderer/src/components/sidebar/SidebarAurora";

const readSource = (path: string) => readFileSync(new URL(`../../src/renderer/src/${path}`, import.meta.url), "utf8")
  .replace(/\r\n/gu, "\n")
  .replace(/\/\*[\s\S]*?\*\//gu, "");
const css = readSource("components/sidebar/sidebar-aurora.css");

function nested(at: string): string {
  const escaped = at.replace(/[()]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{((?:[^{}]*\\{[^}]*\\})*)\\s*\\}`, "u").exec(css);
  if (!match) throw new Error(`Missing ${at}`);
  return match[1]!;
}

const seconds = (value: string) => Number(/^([\d.]+)s$/u.exec(value)?.[1]);

/** Top-level rules only; nested @keyframes/@media bodies are read separately. */
function block(selector: string, source = css): string {
  const topLevel = source.replace(/@(?:keyframes|media)[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/gu, "");
  for (const [, selectors, body] of topLevel.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (selectors!.trim() === selector) return body!;
  }
  throw new Error(`Missing rule: ${selector}`);
}

function declaration(body: string, property: string): string;
function declaration(body: string, property: string, optional: true): string | null;
function declaration(body: string, property: string, optional = false): string | null {
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`, "u").exec(body);
  if (!match) {
    if (optional) return null;
    throw new Error(`Missing ${property}`);
  }
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

  it("drifts a faint third band one tile per loop against the near lights", () => {
    const band = block(".sidebar-aurora-band");
    expect(declaration(block(".sidebar-aurora-near,\n.sidebar-aurora-band,\n.sidebar-aurora-far"), "animation-iteration-count")).toBe("infinite");
    expect(declaration(band, "animation-name")).toBe("sidebar-sky-band");
    expect(declaration(band, "animation-duration")).toBe("var(--aurora-band-duration)");
    expect(seconds(declaration(block(".sidebar-aurora"), "--aurora-band-duration"))).toBe(26);
    expect(declaration(band, "width")).toBe("calc(100% + 208px)");
    expect(declaration(band, "background-size")).toBe("208px 100%");
    expect(nested("@keyframes sidebar-sky-band")).toMatch(/from \{ transform: translate3d\(-208px, 0, 0\); \}\s*to \{ transform: translate3d\(0, 0, 0\); \}/u);
    expect(nested("@keyframes sidebar-aurora-drift-near")).toMatch(/to \{ transform: translate3d\(-400px, 0, 0\); \}/u);
    expect(declaration(band, "--aurora-light-e")).toBe("color-mix(in srgb, var(--aurora-3) calc(var(--aurora-mid-live) / 2), transparent)");
  });

  it("parallaxes the starfield a few pixels on the stepped timer", () => {
    const field = block(".sidebar-aurora-stars");
    expect(declaration(field, "animation")).toBe("sidebar-sky-parallax var(--aurora-parallax-duration) ease-in-out infinite paused");
    expect(declaration(block(".sidebar-aurora > span"), "animation-play-state")).toBe("paused");
    expect(seconds(declaration(block(".sidebar-aurora"), "--aurora-parallax-duration"))).toBe(40);
    const offsets = [...nested("@keyframes sidebar-sky-parallax").matchAll(/translate3d\((-?[\d.]+)(?:px)?, (-?[\d.]+)(?:px)?, 0\)/gu)]
      .flatMap(([, x, y]) => [Number(x), Number(y)]);
    expect(offsets.length).toBeGreaterThan(0);
    for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(6);
  });

  it("breathes each star in a plain CSS animation that plays only while the strip is live", () => {
    expect(declaration(block(".sidebar-aurora.is-moving .sidebar-star"), "animation"))
      .toBe("sidebar-star-breathe-far var(--star-cycle) ease-in-out calc(var(--star-cycle) * var(--star-phase) * -1) infinite paused");
    expect(declaration(block('.sidebar-aurora.is-moving .sidebar-star[data-depth="near"]'), "animation-name")).toBe("sidebar-star-breathe-near");
    expect(declaration(block(".sidebar-aurora.is-live .sidebar-star"), "animation-play-state")).toBe("running");
    expect(css.indexOf(".sidebar-aurora.is-live .sidebar-star {")).toBeGreaterThan(css.indexOf(".sidebar-aurora.is-moving .sidebar-star {"));
    expect(declaration(block(".sidebar-star"), "animation", true)).toBeNull();
    const aurora = block(".sidebar-aurora");
    const shortest = seconds(declaration(aurora, "--star-breathe-shortest"));
    expect([shortest, shortest + seconds(declaration(aurora, "--star-breathe-range"))]).toEqual([7, 12]);
    expect(declaration(block(".sidebar-star"), "--star-cycle"))
      .toBe("calc(var(--star-breathe-shortest) + var(--star-breathe-range) * var(--star-t))");
    expect(nested("@keyframes sidebar-star-breathe-far")).toMatch(/^\s*0%, 100% \{ opacity: 0\.2; \}\s*50% \{ opacity: 0\.55; \}\s*$/u);
    expect(nested("@keyframes sidebar-star-breathe-near")).toMatch(/^\s*0%, 100% \{ opacity: 0\.35; \}\s*50% \{ opacity: 0\.85; \}\s*$/u);
    expect(css).not.toMatch(/sidebar-star-(?:twinkle|glint)|\bfilter\s*:/u);
  });

  it("paints each star once: a 1px far dot or a 2px near core with a 3px glow, resting at mid strength", () => {
    const star = block(".sidebar-star");
    expect(declaration(star, "--star-size")).toBe("1px");
    expect(declaration(star, "position")).toBe("absolute");
    expect(declaration(star, "margin")).toBe("calc(var(--star-size) / -2) 0 0 calc(var(--star-size) / -2)");
    expect(declaration(star, "background")).toBe("var(--star-color)");
    expect(Number(declaration(star, "opacity"))).toBeCloseTo((0.2 + 0.55) / 2, 6);
    const near = block('.sidebar-star[data-depth="near"]');
    expect(declaration(near, "--star-size")).toBe("8px");
    expect(declaration(near, "background")).toBe(
      "radial-gradient(closest-side, var(--star-color) 25%, color-mix(in srgb, var(--star-color) 28%, transparent) 50%, transparent)",
    );
    expect(Number(declaration(near, "opacity"))).toBeCloseTo((0.35 + 0.85) / 2, 6);
    expect(declaration(block('.platform-darwin .sidebar-star[data-macos="hidden"]'), "display")).toBe("none");
  });

  it("colours the stars from theme tokens only: a faint accent speck in light, text toward the aurora in dark", () => {
    expect(declaration(block(".sidebar-aurora"), "--star-color")).toBe("color-mix(in srgb, var(--accent) 30%, transparent)");
    expect(declaration(block(':root[data-theme="dark"] .sidebar-aurora'), "--star-color"))
      .toBe("color-mix(in srgb, var(--text) 72%, var(--aurora-1))");
    expect(css.replace(/url\("data:[^"]*"\)/gu, "")).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(|\b(?:white|black)\b/iu);
  });

  it("changes only transform and opacity in every keyframe", () => {
    const names: string[] = [];
    for (const [, name, body] of css.matchAll(/@keyframes ([\w-]+) \{((?:[^{}]*\{[^}]*\})*)\s*\}/gu)) {
      names.push(name!);
      const properties = [...body!.matchAll(/([\w-]+):/gu)].map(([, property]) => property);
      expect(properties.filter((property) => property !== "transform" && property !== "opacity"), name).toEqual([]);
    }
    expect(names).toEqual(expect.arrayContaining([
      "sidebar-sky-band", "sidebar-sky-parallax", "sidebar-star-breathe-far", "sidebar-star-breathe-near",
    ]));
  });

  it("rests the stars for reduced motion and hides every layer for forced colours", () => {
    const reduced = nested("@media (prefers-reduced-motion: reduce)");
    expect(declaration(block(".sidebar-aurora > span", reduced), "animation")).toBe("none");
    expect(declaration(block(
      '.sidebar-aurora.is-moving .sidebar-star,\n  .sidebar-aurora.is-moving .sidebar-star[data-depth="near"]',
      reduced,
    ), "animation")).toBe("none");
    const forced = nested("@media (forced-colors: active)");
    expect(declaration(block(".sidebar-aurora", forced), "display")).toBe("none");
    expect(declaration(block(".sidebar::before", forced), "display")).toBe("none");
  });

  it("leaves hidden windows to the root pause, which also reaches the stars", () => {
    const pause = readSource("background-motion.css");
    for (const selector of ["*", "*::before", "*::after"]) {
      expect(pause).toContain(`:root[data-document-visible="false"] ${selector}`);
    }
    expect(pause).toContain("animation-play-state: paused !important;");
    expect(pause).toContain("animation-duration: 0s !important;");
    expect(css).not.toContain("!important");
  });

  it("keeps the sidebar passing motion and work state to the light", () => {
    const sidebar = readSource("components/Sidebar.tsx");
    expect(sidebar).toContain("const auroraActivity = useMemo(() => sidebarAuroraActivity(threadViewsById.values()), [threadViewsById]);");
    expect(sidebar).toContain("<SidebarAurora moving={!reducedMotion && (!mobile || open)} activity={auroraActivity} />");
  });
});
