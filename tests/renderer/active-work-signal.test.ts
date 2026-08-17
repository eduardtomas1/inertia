import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const baseCss = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const exactMotionCssSource = readFileSync(
  new URL("../../src/renderer/src/components/BeautifulUiMotion.css", import.meta.url),
  "utf8",
);
const css = `${baseCss}\n${exactMotionCssSource}`;
const timelineSource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/layers.tsx", import.meta.url),
  "utf8",
);

function cssBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return "";
  const openIndex = source.indexOf("{", markerIndex);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return "";
}

const activePixelMarker = '.agent-pixel-loader[data-animated="true"] > span';
const finalReducedMotionIndex = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
const exactMotionCss = css.slice(
  css.lastIndexOf(activePixelMarker, finalReducedMotionIndex - 1),
  finalReducedMotionIndex,
);
const activePixelRule = cssBlock(exactMotionCss, activePixelMarker);

describe("Minimal Workstream active pixel signal", () => {
  it("attaches the active-state hook only inside the active execution branch", () => {
    const activeBranchStart = timelineSource.indexOf("{turn.isActive ? (");
    const settledBranchStart = timelineSource.indexOf(") : (", activeBranchStart);
    const activeBranch = timelineSource.slice(activeBranchStart, settledBranchStart);
    const settledBranch = timelineSource.slice(
      settledBranchStart,
      timelineSource.indexOf(")}", settledBranchStart),
    );

    expect(activeBranch).toContain('data-active-work-region=""');
    expect(activeBranch).toContain(
      "data-active-work-state={turn.agentTurn.status}",
    );
    expect(activeBranch).toContain(
      "data-active-agent-phase={activePresentation.phase}",
    );
    expect(activeBranch).toContain("<AgentPixelLoader");
    expect(timelineSource).toContain("data-phase={phase}");
    expect(settledBranch).not.toContain("data-active-work-region");
    expect(settledBranch).not.toContain("<AgentPixelLoader");
  });

  it("keeps pixel motion on the derived state and mirrors the reference label shimmer", () => {
    expect(timelineSource).toContain("animated={activePresentation.animated}");
    expect(timelineSource).toContain('data-animated={animated ? "true" : "false"}');
    expect(timelineSource).toContain("AGENT_PIXEL_GRID_CELLS = Array.from");
    expect(exactMotionCss).toContain("--pixel-drive-delay: 90ms");
    expect(exactMotionCss).toContain("--pixel-orbit-delay: 770ms");
    expect(css).toContain('.agent-pixel-loader[data-animated="true"] > span');
    expect(css).toContain("animation: beautiful-shimmer-text 1.4s linear infinite");
    expect(css).not.toContain(".turn-working-status::before");
    expect(css).not.toContain("active-work-tonal-wash");
  });

  it("moves one restrained shimmer through a fixed nine-pixel grid", () => {
    expect(activePixelRule).toContain("agent-pixel-shimmer");
    const keyframes = cssBlock(
      css.slice(css.lastIndexOf("@keyframes agent-pixel-shimmer")),
      "@keyframes agent-pixel-shimmer",
    );

    expect(activePixelRule).toContain("agent-pixel-shimmer 650ms");
    expect(activePixelRule).toContain("ease-in-out infinite");
    expect(keyframes).toContain("opacity: .15");
    expect(keyframes).toContain("opacity: 1");
    expect(`${activePixelRule}\n${keyframes}`).not.toMatch(/transform:|scale:/iu);
  });

  it("keeps Dots, Drive, and Orbit inside the same bounded pixel grid", () => {
    const orbitCenterRule = cssBlock(
      exactMotionCss,
      '.agent-pixel-loader[data-animated="true"][data-phase="thinking"] > span:nth-child(5)',
    );
    const dotsRule = cssBlock(
      css,
      '.agent-pixel-loader:is([data-phase="queued"], [data-phase="starting"]) > span',
    );

    expect(dotsRule).toContain("border-radius: 50%");
    expect(orbitCenterRule).toContain("animation: none");
    expect(orbitCenterRule).toContain("opacity: .07");
    expect(exactMotionCss).toContain("--pixel-orbit-delay: 770ms");
    expect(css).not.toMatch(/agent-pixel-loader[^}]*url\(/su);
  });

  it("uses a static readable grid when reduced motion is requested", () => {
    const reducedMotion = css.slice(
      css.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );
    const reducedPixelRule = cssBlock(
      reducedMotion,
      '.agent-pixel-loader[data-animated="true"] > span',
    );

    expect(reducedPixelRule).toContain("animation: none");
    expect(reducedPixelRule).toContain("opacity: .15");
    expect(reducedMotion).toContain(".turn-working-status .turn-working-copy strong");
    expect(reducedMotion).toContain("background: none");
    expect(reducedMotion).toContain(
      '.agent-pixel-loader[data-animated="true"][data-phase="thinking"] > span:nth-child(5)',
    );
  });

  it("keeps the grid visible in forced-colors mode", () => {
    const forcedColors = css.slice(
      css.lastIndexOf("@media (forced-colors: active)"),
    );
    const forcedColorsPixelRule = cssBlock(
      forcedColors,
      ".agent-pixel-loader",
    );

    expect(forcedColorsPixelRule).toContain("color: CanvasText");
    expect(forcedColorsPixelRule).toContain("forced-color-adjust: auto");
  });

  it("keeps running glyph motion scoped to the authoritative active region", () => {
    expect(css).toContain(
      "[data-active-work-region] .turn-work-log .agent-activity.is-running > svg",
    );
    expect(css).not.toMatch(
      /^\.turn-work-log \.agent-activity\.is-running > svg\s*\{[^}]*animation:/mu,
    );
  });
});
