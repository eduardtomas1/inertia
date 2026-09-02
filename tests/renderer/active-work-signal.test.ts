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
const supportingMotionCss = [
  "DailyWorkDialog.css",
  "composer/ComposerCommandMenu.css",
  "composer/ComposerSendActions.css",
].map((fileName) => readFileSync(
  new URL(`../../src/renderer/src/components/${fileName}`, import.meta.url),
  "utf8",
)).join("\n");
const css = `${baseCss}\n${exactMotionCssSource}\n${supportingMotionCss}`;
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
const finalReducedMotionIndex = exactMotionCssSource.lastIndexOf(
  "@media (prefers-reduced-motion: reduce)",
);
const exactMotionCss = exactMotionCssSource.slice(
  exactMotionCssSource.lastIndexOf(
    activePixelMarker,
    finalReducedMotionIndex - 1,
  ),
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
      "data-active-work-state={runState}",
    );
    expect(activeBranch).toContain(
      "data-active-agent-phase={activePresentation.phase}",
    );
    expect(activeBranch).toContain("<AgentPixelLoader");
    expect(timelineSource).toContain("data-phase={phase}");
    expect(settledBranch).not.toContain("data-active-work-region");
    expect(settledBranch).not.toContain("<AgentPixelLoader");
  });

  it("keeps pixel motion on the derived state with a static working label", () => {
    expect(timelineSource).toContain("animated={activePresentation.animated}");
    expect(timelineSource).toContain('data-animated={animated ? "true" : "false"}');
    expect(timelineSource).toContain("AGENT_PIXEL_GRID_CELLS = Array.from");
    expect(exactMotionCss).toContain("--pixel-drive-delay: 90ms");
    expect(exactMotionCss).toContain("--pixel-orbit-delay: 770ms");
    expect(css).toContain('.agent-pixel-loader[data-animated="true"] > span');
    expect(css).not.toContain("beautiful-shimmer-text");
    expect(css).toMatch(/\.turn-working-status \.turn-working-copy strong\s*\{[^}]*color:\s*var\(--text-soft\);/su);
    expect(css).not.toContain("will-change:");
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
    const reducedMotion = exactMotionCssSource.slice(
      exactMotionCssSource.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
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
    const forcedColors = exactMotionCssSource.slice(
      exactMotionCssSource.lastIndexOf("@media (forced-colors: active)"),
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
      "[data-active-work-region] .turn-work-log .agent-activity.is-running > .agent-activity-icon",
    );
    expect(css).not.toMatch(
      /^\.turn-work-log \.agent-activity\.is-running > svg\s*\{[^}]*animation:/mu,
    );
  });

  it("pauses every remaining infinite active-work animation while hidden", () => {
    const hiddenRules = css.match(
      /\.app-shell\[data-document-visible="false"\][\s\S]*?animation-play-state:\s*paused;/gu,
    )?.join("\n") ?? "";
    for (const selector of [
      ".plan-step.is-in-progress .plan-step-marker svg",
      '.agent-pixel-loader[data-animated="true"] > span',
      ".turn-reasoning-step.is-active::before",
      '.subagent-status-mark[data-live="true"]::after',
      '.subagent-disclosure[data-active="true"] > summary > svg:first-child',
      ".agent-activity.is-running .agent-activity-icon::after",
      ".loading-mark",
      ".daily-work-skeleton i",
      ".daily-work-badge.is-running::before",
      ".composer-status-dots i",
      '.send-button[data-motion-state="sending"] .composer-send-motion-icon',
    ]) {
      expect(hiddenRules).toContain(selector);
    }
  });
});
