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

const activeWashRule = cssBlock(
  css,
  '[data-active-work-region][data-active-work-state="running"]::before',
);

describe("Minimal Workstream active-work wash", () => {
  it("attaches the wash hook only inside the active execution branch", () => {
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

  it("animates only queued, starting, and running work—not waiting or terminal states", () => {
    for (const status of ["queued", "starting", "running"]) {
      expect(css).toContain(
        `[data-active-work-region][data-active-work-state="${status}"]::before`,
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
        `[data-active-work-region][data-active-work-state="${status}"]::before`,
      );
    }

    expect(css).not.toMatch(
      /\.(?:turn-final-answer-document|agent-request-card)[^{]*\{[^}]*active-work-tonal-wash/su,
    );
  });

  it("uses the semantic active-work colors and opacity with broad transparent edges", () => {
    expect(activeWashRule).toContain("var(--active-work-gradient-primary)");
    expect(activeWashRule).toContain("var(--active-work-gradient-secondary)");
    expect(activeWashRule).toContain(
      "opacity: var(--active-work-gradient-opacity)",
    );
    expect(activeWashRule).toMatch(
      /linear-gradient\(\s*90deg,\s*transparent 0%,\s*transparent 18%/su,
    );
    expect(activeWashRule).toMatch(
      /transparent 82%,\s*transparent 100%\s*\)/su,
    );
    expect(activeWashRule).toContain("background-size: 100% 100%");
  });

  it("drifts on the compositor on a calm cadence without layout or paint-position animation", () => {
    const duration =
      Number(
        activeWashRule.match(
          /active-work-tonal-wash\s+(?<seconds>\d+(?:\.\d+)?)s/u,
        )?.groups?.seconds,
      ) || 0;
    const keyframes = cssBlock(css, "@keyframes active-work-tonal-wash");

    expect(duration).toBeGreaterThanOrEqual(3);
    expect(duration).toBeLessThanOrEqual(5);
    expect(activeWashRule).toContain("will-change: transform");
    expect(activeWashRule).toContain("transform: translate3d(-8%, 0, 0)");
    expect(activeWashRule).toContain("linear infinite alternate");
    expect(activeWashRule).toContain("infinite alternate");
    expect(keyframes).toContain("transform: translate3d(8%, 0, 0)");
    expect(`${activeWashRule}\n${keyframes}`).not.toMatch(
      /animation-delay|opacity:[^;]*\n[^}]*opacity:|scale|width:|translateX|background-position:[^;]*\n[^}]*background-position/iu,
    );
  });

  it("keeps a static subtle tint when reduced motion is requested", () => {
    const reducedMotion = css.slice(
      css.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );
    const reducedWashRule = cssBlock(
      reducedMotion,
      '[data-active-work-region][data-active-work-state="running"]::before',
    );

    expect(reducedWashRule).toContain("animation: none");
    expect(reducedWashRule).toContain("background-position: 50% 50%");
    expect(activeWashRule).toContain(
      "opacity: var(--active-work-gradient-opacity)",
    );
  });

  it("scopes running glyph motion to the authoritative active region", () => {
    expect(css).toContain(
      "[data-active-work-region] .turn-work-log .agent-activity.is-running > svg",
    );
    expect(css).not.toMatch(
      /^\.turn-work-log \.agent-activity\.is-running > svg\s*\{[^}]*animation:/mu,
    );
  });
});
