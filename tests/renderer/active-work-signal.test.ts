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
const activityGroupCss = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/ActivityGroup.css", import.meta.url),
  "utf8",
);
const css = `${baseCss}\n${exactMotionCssSource}\n${supportingMotionCss}\n${activityGroupCss}`;

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

describe("Minimal Workstream active pixel signal", () => {
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

  it("pauses every remaining infinite active-work animation while hidden", () => {
    const hiddenRules = css.match(
      /\.app-shell\[data-document-visible="false"\][\s\S]*?animation-play-state:\s*paused;/gu,
    )?.join("\n") ?? "";
    for (const selector of [
      '.agent-pixel-loader[data-animated="true"] > span',
      ".turn-reasoning-step.is-active::before",
      '.subagent-status-mark[data-live="true"]::after',
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

  it("pauses document-preview portal spinners while hidden", () => {
    const portalRule = css.match(
      /\.attachment-preview-backdrop\[data-document-visible="false"\][\s\S]*?animation-play-state:\s*paused;/u,
    )?.[0] ?? "";

    expect(portalRule).toContain(".loading-mark");
  });
});
