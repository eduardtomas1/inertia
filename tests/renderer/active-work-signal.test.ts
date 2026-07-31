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

const activeTextRule = cssBlock(
  css,
  '[data-active-work-region][data-active-work-state="running"] .turn-working-status strong',
);

describe("Minimal Workstream active text signal", () => {
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
    expect(settledBranch).not.toContain("data-active-work-region");
  });

  it("animates working text only for queued, starting, and running work", () => {
    for (const status of ["queued", "starting", "running"]) {
      expect(css).toContain(
        `[data-active-work-region][data-active-work-state="${status}"] .turn-working-status strong`,
      );
    }

    for (const status of [
      "waiting-for-approval",
      "waiting-for-input",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]) {
      expect(css).not.toContain(
        `[data-active-work-region][data-active-work-state="${status}"] .turn-working-status strong`,
      );
    }

    expect(css).not.toContain(".turn-working-status::before");
    expect(css).not.toContain("active-work-tonal-wash");
  });

  it("moves one restrained semantic highlight through the label", () => {
    expect(activeTextRule).toContain("var(--active-work-text-rest)");
    expect(activeTextRule).toContain("var(--active-work-text-highlight)");
    expect(activeTextRule).toContain("background-clip: text");
    expect(activeTextRule).toContain("-webkit-text-fill-color: transparent");
    expect(activeTextRule).toContain("background-size: 300% 100%");

    const duration =
      Number(
        activeTextRule.match(
          /active-work-text-wave\s+(?<seconds>\d+(?:\.\d+)?)s/u,
        )?.groups?.seconds,
      ) || 0;
    const keyframes = cssBlock(css, "@keyframes active-work-text-wave");

    expect(duration).toBeGreaterThanOrEqual(2.4);
    expect(duration).toBeLessThanOrEqual(3.6);
    expect(activeTextRule).toContain("linear infinite");
    expect(keyframes).toContain("background-position: 90% 50%");
    expect(keyframes).toContain("background-position: 8% 50%");
    expect(`${activeTextRule}\n${keyframes}`).not.toMatch(
      /transform:|scale|width:|opacity:/iu,
    );
  });

  it("uses static readable text when reduced motion is requested", () => {
    const reducedMotion = css.slice(
      css.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );
    const reducedTextRule = cssBlock(
      reducedMotion,
      '[data-active-work-region][data-active-work-state="running"] .turn-working-status strong',
    );

    expect(reducedTextRule).toContain("animation: none");
    expect(reducedTextRule).toContain("background: none");
    expect(reducedTextRule).toContain(
      "-webkit-text-fill-color: currentColor",
    );
  });

  it("keeps the working label visible in forced-colors mode", () => {
    const forcedColors = css.slice(
      css.lastIndexOf("@media (forced-colors: active)"),
    );
    const forcedColorsTextRule = cssBlock(
      forcedColors,
      '[data-active-work-region][data-active-work-state="running"] .turn-working-status strong',
    );

    expect(forcedColorsTextRule).toContain("color: CanvasText");
    expect(forcedColorsTextRule).toContain("background: none");
    expect(forcedColorsTextRule).toContain(
      "-webkit-text-fill-color: currentColor",
    );
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
