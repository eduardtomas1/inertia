import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  shouldCollapseSuccessfulWorkOnSettlement,
} from "../../src/renderer/src/components/ResponseTimeline";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
);
const appLayoutSource = readFileSync(
  new URL("../../src/renderer/src/components/AppLayout.tsx", import.meta.url),
  "utf8",
);
const activitySource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/activity.tsx", import.meta.url),
  "utf8",
);
const layersSource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/layers.tsx", import.meta.url),
  "utf8",
);
const turnSource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/turn.tsx", import.meta.url),
  "utf8",
);
const viewportSource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/viewport.tsx", import.meta.url),
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
  it("keeps frequent surfaces opaque while reserving backdrop blur for rare dialogs", () => {
    for (const selector of [
      ".activity-center {",
      ".environment-panel {",
      ".palette-backdrop {",
      ".composer-suggestion-menu,",
    ]) {
      const block = cssBlock(css, selector);
      const filters = [...block.matchAll(/backdrop-filter:\s*([^;]+)/gu)]
        .map((match) => match[1]?.trim());
      expect(filters.every((value) => value === "none"), selector).toBe(true);
    }
    expect(css).toMatch(
      /\.commit-dialog,\s*\.provider-auth-dialog\s*\{[^}]*backdrop-filter:\s*var\(--glass-filter\)/su,
    );
  });

  it("gates settlement motion on a turn that was active so history stays still on load", () => {
    expect(turnSource).toContain("const wasActive = useRef(turn.isActive)");
    expect(turnSource).toContain("const [settlingTransition, setSettlingTransition] = useState<");
    expect(turnSource).toContain("const isSettling = settlingTransition !== null");
    expect(turnSource).toContain("setSettlingTransition({");
    expect(turnSource).toContain("const TURN_SETTLEMENT_TRANSITION_MS = 160");
    expect(turnSource).toContain("TURN_SETTLEMENT_TRANSITION_MS");
    expect(turnSource).toContain('isSettling && "is-settling"');
    expect(turnSource).toContain(
      'data-completion-transition={isSettling ? "active-to-settled" : undefined}',
    );
    expect(css).toContain(
      ".response-turn.is-settling .turn-execution-rail.is-settled",
    );
    expect(css).not.toContain("@starting-style");
  });

  it("reveals a persisted final document even when its terminal row arrived while active", () => {
    expect(turnSource).not.toContain("renderedAnswerWhileActive");
    expect(turnSource).toContain(
      "const isRevealingSettledAnswer = settlingTransition?.revealAnswer ?? false",
    );
    expect(turnSource).toContain(
      "revealAnswer: Boolean(turn.terminalAssistantMessage?.content)",
    );
    expect(turnSource).toContain(
      "settlingTransition",
    );
    expect(turnSource).toContain(
      "&& turn.terminalAssistantMessage?.content",
    );
    expect(turnSource).toContain(
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
    for (const offset of motion.matchAll(/translateY\((-?(?<offset>\d+))px\)/gu)) {
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
    expect(activitySource).toContain("const workWasActive = useRef(turn.isActive)");
    expect(activitySource).toContain(
      "if (shouldCollapse) setExpanded(false)",
    );
  });

  it("keeps active glyph and settlement motion still for reduced motion", () => {
    const reducedMotion = cssBlock(css, "@media (prefers-reduced-motion: reduce)");
    const quietLedgerReducedMotion = css.slice(
      css.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );

    expect(reducedMotion).toContain("animation: none");
    expect(activitySource).not.toContain("turn-working-pulse");
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

  it("pauses live timers and the active text signal while the document is inactive", () => {
    expect(activitySource).toContain('document.visibilityState !== "visible"');
    expect(activitySource).toContain("!document.hasFocus()");
    expect(activitySource).toContain('document.addEventListener("visibilitychange", synchronize)');
    expect(activitySource).toContain('window.addEventListener("blur", synchronize)');
    expect(appSource).toContain("function useDocumentActive()");
    expect(appLayoutSource).toContain(
      'data-document-active={documentActive ? "true" : "false"}',
    );
    expect(activitySource).toContain("memo(function ActivityRow");
    expect(activitySource).toContain("memo(function ActivityGroup");
    expect(activitySource).toContain("const durableStream = useMemo(");
    expect(activitySource).toContain("instead of sorting the complete workstream");
    expect(css).toContain('data-document-active="false"');
    expect(css).toContain("animation-play-state: paused");
    expect(css).toContain("active-work-text-wave");
    expect(css).not.toContain("active-work-tonal-wash");
  });

  it("keeps completion on the same keyed row and leaves follow/virtualization behavior untouched", () => {
    expect(turnSource).toContain("data-response-row-id={turn.id}");
    expect(turnSource).toContain("data-turn-id={turn.id}");
    expect(viewportSource).toContain(
      "(index: number) => timelineRef.current[index]?.id ?? `missing-${index}`",
    );
    expect(viewportSource).toContain("key={virtualItem.key}");
    expect(viewportSource).toContain(
      'timeline.map((item) => <div className="response-static-item" key={item.id}>',
    );
    expect(viewportSource).toContain("anchorTo: \"end\"");
    expect(viewportSource).toContain("followOnAppend: false");
    expect(`${turnSource}\n${viewportSource}`).not.toMatch(
      /isSettling[\s\S]{0,500}(?:scrollIntoView|scrollToIndex|scrollTop\s*=)/u,
    );
  });

  it("uses one atomic completion announcement without exposing timers or tokens", () => {
    const completionMarker = layersSource.indexOf('data-turn-completion-announcement=""');
    const completionStart = layersSource.lastIndexOf("<span", completionMarker);
    const completionRegion = layersSource.slice(
      completionStart,
      layersSource.indexOf("</span>", completionMarker),
    );
    expect(completionRegion).toContain('role="status"');
    expect(completionRegion).toContain('aria-live="polite"');
    expect(completionRegion).toContain('aria-atomic="true"');
    expect(completionRegion).toContain("{completionAnnouncement}");
    expect(completionRegion).not.toContain("LiveElapsed");
    expect(completionRegion).not.toContain("streamingText");
    expect(turnSource).toContain(
      "const announcement = turnCompletionAnnouncement(wasActive.current, turn, providerLabel)",
    );
  });
});
