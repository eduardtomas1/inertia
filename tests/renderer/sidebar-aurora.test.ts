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

function pixels(value: string): number {
  return Number.parseFloat(value);
}

const keyframes = new Map(
  [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/gu)]
    .map(([, name, body]) => [name!, body!]),
);

describe("sidebar aurora", () => {
  it("animates only compositor properties with literal keyframe values", () => {
    expect([...keyframes.keys()].sort()).toEqual([
      "sidebar-aurora-breathe",
      "sidebar-aurora-drift-far",
      "sidebar-aurora-drift-near",
    ]);
    for (const [name, body] of keyframes) {
      const properties = [...body.matchAll(/([\w-]+)\s*:/gu)].map(([, property]) => property);
      expect(new Set(properties), name).toEqual(
        new Set(properties.filter((property) => property === "transform" || property === "opacity")),
      );
      expect(body, `${name} keeps literal values so it stays compositable`).not.toContain("var(");
    }
  });

  it("leaves the layers paused for the coarse timer and stops them for reduced motion", () => {
    expect(declaration(block(".sidebar-aurora > span"), "animation-play-state")).toBe("paused");
    expect(declaration(block(".sidebar-aurora-glow"), "animation")).toMatch(/\bpaused$/u);
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/u.exec(css);
    expect(reduced).not.toBeNull();
    expect(declaration(block(".sidebar-aurora > span", reduced![1]!), "animation")).toBe("none");
    expect(SIDEBAR_AURORA_STEP_MS).toBeGreaterThanOrEqual(80);
    expect(SIDEBAR_AURORA_STEP_MS).toBeLessThanOrEqual(200);
  });

  it("stays decorative, below the brand, and free of extra render passes", () => {
    const root = block(".sidebar-aurora");
    expect(declaration(root, "pointer-events")).toBe("none");
    expect(declaration(root, "z-index")).toBe("-1");
    expect(declaration(root, "overflow")).toBe("hidden");
    expect(declaration(root, "contain")).toBe("strict");
    expect(css).not.toMatch(/(?:^|[\s;{])(?:-webkit-)?(?:mask|mask-image|filter|backdrop-filter|mix-blend-mode)\s*:/u);
  });

  it.each([
    [".sidebar-aurora-near", "sidebar-aurora-drift-near"],
    [".sidebar-aurora-far", "sidebar-aurora-drift-far"],
  ])("loops %s by exactly one gradient tile with every light inside it", (selector, animationName) => {
    const layer = block(selector);
    expect(declaration(layer, "animation-name")).toBe(animationName);
    const tile = pixels(declaration(layer, "background-size"));
    expect(declaration(layer, "width")).toBe(`calc(100% + ${tile}px)`);
    // An omitted `from` keyframe starts at the untransformed position.
    const distances = [0, ...[...keyframes.get(animationName)!.matchAll(/translate3d\((-?\d+)px/gu)]
      .map(([, value]) => Number(value))];
    expect(Math.max(...distances) - Math.min(...distances)).toBe(tile);

    const height = pixels(declaration(block(".sidebar-aurora"), "height"));
    const lights = [...layer.matchAll(/radial-gradient\((\d+)px (\d+)px at (\d+)px (\d+)px/gu)]
      .map(([, rx, ry, x, y]) => ({ rx: Number(rx), ry: Number(ry), x: Number(x), y: Number(y) }));
    expect(lights).toHaveLength(2);
    for (const { rx, ry, x, y } of lights) {
      expect(x - rx, `${selector} light starts inside its tile`).toBeGreaterThanOrEqual(0);
      expect(x + rx, `${selector} light ends inside its tile`).toBeLessThanOrEqual(tile);
      expect(y + ry, `${selector} light fades out before the search row`).toBeLessThanOrEqual(height - 8);
    }
  });

  it("drifts about one pixel per timer step, slowly enough to read as continuous", () => {
    for (const selector of [".sidebar-aurora-near", ".sidebar-aurora-far"]) {
      const layer = block(selector);
      const tile = pixels(declaration(layer, "background-size"));
      const seconds = Number.parseFloat(declaration(layer, "animation-duration"));
      const pixelsPerStep = (tile / seconds) * (SIDEBAR_AURORA_STEP_MS / 1_000);
      expect(pixelsPerStep, selector).toBeGreaterThan(0.5);
      expect(pixelsPerStep, selector).toBeLessThanOrEqual(1.25);
    }
  });
});
