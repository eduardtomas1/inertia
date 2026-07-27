import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  shouldCollapseSuccessfulWorkOnSettlement,
} from "../../src/renderer/src/components/ResponseTimeline";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const timelineSource = readFileSync(
  new URL("../../src/renderer/src/components/ResponseTimeline.tsx", import.meta.url),
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

describe("Quiet Ledger active-to-settled motion", () => {
  it("gates settlement motion on a turn that was active so history stays still on load", () => {
    expect(timelineSource).toContain("const wasActive = useRef(turn.isActive)");
    expect(timelineSource).toContain("const [settlingTransition, setSettlingTransition] = useState<");
    expect(timelineSource).toContain("const isSettling = settlingTransition !== null");
    expect(timelineSource).toContain("setSettlingTransition({");
    expect(timelineSource).toContain("window.setTimeout(() => setSettlingTransition(null), 220)");
    expect(timelineSource).toContain('isSettling && "is-settling"');
    expect(timelineSource).toContain(
      'data-completion-transition={isSettling ? "active-to-settled" : undefined}',
    );
    expect(css).toContain(
      ".response-turn.is-settling .turn-execution-rail.is-settled",
    );
    expect(css).not.toContain("@starting-style");
  });

  it("reveals a persisted final document even when its terminal row arrived while active", () => {
    expect(timelineSource).not.toContain("renderedAnswerWhileActive");
    expect(timelineSource).toContain(
      "const isRevealingSettledAnswer = settlingTransition?.revealAnswer ?? false",
    );
    expect(timelineSource).toContain(
      "revealAnswer: Boolean(turn.terminalAssistantMessage?.content)",
    );
    expect(timelineSource).toContain(
      "settlingTransition",
    );
    expect(timelineSource).toContain(
      "&& turn.terminalAssistantMessage?.content",
    );
    expect(timelineSource).toContain(
      'isRevealingSettledAnswer && "is-revealing-settled-answer"',
    );
    expect(css).toContain(
      ".response-turn.is-settling.is-revealing-settled-answer",
    );
  });

  it("uses tokenized opacity and tiny vertical movement, with metadata following the answer", () => {
    const settleRule = cssBlock(
      css,
      ".response-turn.is-settling .turn-execution-rail.is-settled",
    );
    const documentRule = cssBlock(
      css,
      ".response-turn.is-settling.is-revealing-settled-answer",
    );
    const supportingRule = cssBlock(
      css,
      ".response-turn.is-settling > .turn-supporting-ledger",
    );
    const delayedSupportingRule = cssBlock(
      css,
      ".response-turn.is-settling.is-revealing-settled-answer > .turn-supporting-ledger",
    );
    const settleFrames = cssBlock(css, "@keyframes quiet-ledger-settle-in");
    const documentFrames = cssBlock(css, "@keyframes quiet-ledger-document-reveal");
    const supportingFrames = cssBlock(css, "@keyframes quiet-ledger-supporting-reveal");
    const motion = `${settleFrames}\n${documentFrames}\n${supportingFrames}`;

    expect(settleRule).toContain(
      "quiet-ledger-settle-in var(--motion-fast) var(--motion-ease) both",
    );
    expect(documentRule).toContain(
      "quiet-ledger-document-reveal var(--motion-base) var(--motion-ease) both",
    );
    expect(supportingRule).toContain(
      "quiet-ledger-supporting-reveal var(--motion-fast) var(--motion-ease) both",
    );
    expect(delayedSupportingRule).toContain(
      "animation-delay: calc(var(--motion-fast) / 2)",
    );
    expect(motion).toContain("opacity:");
    expect(motion).toContain("translateY(");
    expect(motion).not.toMatch(/translateX|translate3d|scale|height|width/iu);
    expect(`${settleRule}\n${documentRule}`).not.toContain("animation-delay");
    expect(motion).not.toMatch(/spring|bounce|overshoot/iu);
    for (const offset of [...motion.matchAll(/translateY\((-?(?<offset>\d+))px\)/gu)]) {
      expect(Math.abs(Number(offset.groups?.offset ?? 0))).toBeLessThanOrEqual(3);
    }
  });

  it("collapses only successful active work when auto-collapse is enabled", () => {
    expect(shouldCollapseSuccessfulWorkOnSettlement({
      wasActive: true,
      isActive: false,
      status: "completed",
      autoCollapse: true,
    })).toBe(true);
    expect(shouldCollapseSuccessfulWorkOnSettlement({
      wasActive: false,
      isActive: false,
      status: "completed",
      autoCollapse: true,
    })).toBe(false);
    expect(shouldCollapseSuccessfulWorkOnSettlement({
      wasActive: true,
      isActive: false,
      status: "failed",
      autoCollapse: true,
    })).toBe(false);
    expect(shouldCollapseSuccessfulWorkOnSettlement({
      wasActive: true,
      isActive: false,
      status: "completed",
      autoCollapse: false,
    })).toBe(false);
    expect(timelineSource).toContain("const workWasActive = useRef(turn.isActive)");
    expect(timelineSource).toContain(
      "if (shouldCollapse) setExpanded(false)",
    );
  });

  it("keeps active glyph and settlement motion still for reduced motion", () => {
    const reducedMotion = cssBlock(css, "@media (prefers-reduced-motion: reduce)");
    const quietLedgerReducedMotion = css.slice(
      css.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );

    expect(reducedMotion).toContain("animation: none");
    expect(timelineSource).not.toContain("turn-working-pulse");
    expect(quietLedgerReducedMotion).toContain(
      ".turn-work-log .agent-activity.is-running svg",
    );
    expect(quietLedgerReducedMotion).toContain(
      ".response-turn.is-settling .turn-execution-rail.is-settled",
    );
    expect(quietLedgerReducedMotion).toContain(
      ".response-turn.is-settling > .turn-supporting-ledger",
    );
    expect(quietLedgerReducedMotion).toContain("animation: none");
    expect(quietLedgerReducedMotion).toContain("opacity: 1");
    expect(quietLedgerReducedMotion).toContain("transform: none");
  });

  it("keeps completion on the same keyed row and leaves follow/virtualization behavior untouched", () => {
    expect(timelineSource).toContain("data-response-row-id={turn.id}");
    expect(timelineSource).toContain("data-turn-id={turn.id}");
    expect(timelineSource).toContain(
      "(index: number) => timeline[index]?.id ?? `missing-${index}`",
    );
    expect(timelineSource).toContain("key={virtualItem.key}");
    expect(timelineSource).toContain(
      'timeline.map((item) => <div className="response-static-item" key={item.id}>',
    );
    expect(timelineSource).toContain("anchorTo: \"end\"");
    expect(timelineSource).toContain("followOnAppend: false");
    expect(timelineSource).not.toMatch(
      /isSettling[\s\S]{0,500}(?:scrollIntoView|scrollToIndex|scrollTop\s*=)/u,
    );
  });

  it("uses one atomic completion announcement without exposing timers or tokens", () => {
    const completionMarker = timelineSource.indexOf('data-turn-completion-announcement=""');
    const completionStart = timelineSource.lastIndexOf("<span", completionMarker);
    const completionRegion = timelineSource.slice(
      completionStart,
      timelineSource.indexOf("</span>", completionMarker),
    );
    expect(completionRegion).toContain('role="status"');
    expect(completionRegion).toContain('aria-live="polite"');
    expect(completionRegion).toContain('aria-atomic="true"');
    expect(completionRegion).toContain("{completionAnnouncement}");
    expect(completionRegion).not.toContain("LiveElapsed");
    expect(completionRegion).not.toContain("streamingText");
    expect(timelineSource).toContain(
      "const announcement = turnCompletionAnnouncement(wasActive.current, turn, providerLabel)",
    );
  });
});
