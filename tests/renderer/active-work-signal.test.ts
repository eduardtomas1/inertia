import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
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

const activePixelRule = cssBlock(
  css,
  '.agent-pixel-loader[data-animated="true"] > span',
);

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
    expect(timelineSource).toContain(
      "data-motion={agentPixelMotionPattern(phase)}",
    );
    expect(settledBranch).not.toContain("data-active-work-region");
    expect(settledBranch).not.toContain("<AgentPixelLoader");
  });

  it("keeps animation authority on the derived pixel state, never the label", () => {
    expect(timelineSource).toContain("animated={activePresentation.animated}");
    expect(timelineSource).toContain('data-animated={animated ? "true" : "false"}');
    expect(timelineSource).toContain("AGENT_PIXEL_GRID_CELLS = [");
    expect(timelineSource).toContain("--pixel-drive-delay");
    expect(timelineSource).toContain("--pixel-orbit-delay");
    expect(css).toContain('.agent-pixel-loader[data-animated="true"] > span');
    expect(css).not.toMatch(/\.turn-working-(?:status|copy)[^{]*\{[^}]*animation:/su);
    expect(css).not.toContain(".turn-working-status::before");
    expect(css).not.toContain("active-work-tonal-wash");
  });

  it("moves one restrained shimmer through a fixed nine-pixel grid", () => {
    expect(activePixelRule).toContain("agent-pixel-shimmer");
    const duration =
      Number(
        activePixelRule.match(
          /agent-pixel-shimmer\s+(?<seconds>\d+(?:\.\d+)?)s/u,
        )?.groups?.seconds,
      ) || 0;
    const keyframes = cssBlock(css, "@keyframes agent-pixel-shimmer");

    expect(duration).toBeGreaterThanOrEqual(1.1);
    expect(duration).toBeLessThanOrEqual(1.8);
    expect(activePixelRule).toContain("ease-in-out infinite");
    expect(keyframes).toContain("opacity: 0.2");
    expect(keyframes).toContain("opacity: 0.96");
    expect(`${activePixelRule}\n${keyframes}`).not.toMatch(/transform:|scale:/iu);
  });

  it("keeps Dots, Drive, and Orbit inside the same bounded pixel grid", () => {
    const orbitCenterRule = cssBlock(
      css,
      '.agent-pixel-loader[data-animated="true"][data-motion="orbit"] > span:nth-child(5)',
    );
    const dotsRule = cssBlock(
      css,
      '.agent-pixel-loader[data-motion="dots"] > span',
    );

    expect(dotsRule).toContain("border-radius: 50%");
    expect(orbitCenterRule).toContain("animation: none");
    expect(orbitCenterRule).toContain("opacity: 0.1");
    expect(timelineSource).toContain("orbitDelay: 840");
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
    expect(reducedPixelRule).toContain("opacity: 0.42");
    expect(reducedMotion).toContain(
      '.agent-pixel-loader[data-animated="true"][data-motion="orbit"] > span:nth-child(5)',
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
