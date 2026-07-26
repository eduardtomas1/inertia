import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
    expect(css).toContain(
      ".response-turn.is-settling .turn-execution-rail.is-settled",
    );
    expect(css).not.toContain("@starting-style");
  });

  it("reveals only a newly appearing final document and leaves a streamed answer stable", () => {
    expect(timelineSource).toContain("const renderedAnswerWhileActive = useRef(");
    expect(timelineSource).toContain(
      "const isRevealingSettledAnswer = settlingTransition?.revealAnswer ?? false",
    );
    expect(timelineSource).toContain(
      'isRevealingSettledAnswer && "is-revealing-settled-answer"',
    );
    expect(css).toContain(
      ".response-turn.is-settling.is-revealing-settled-answer",
    );
  });

  it("uses only tokenized opacity and small vertical movement without delay or layout motion", () => {
    const settleRule = cssBlock(
      css,
      ".response-turn.is-settling .turn-execution-rail.is-settled",
    );
    const documentRule = cssBlock(
      css,
      ".response-turn.is-settling.is-revealing-settled-answer",
    );
    const settleFrames = cssBlock(css, "@keyframes quiet-ledger-settle-in");
    const documentFrames = cssBlock(css, "@keyframes quiet-ledger-document-reveal");
    const motion = `${settleFrames}\n${documentFrames}`;

    expect(settleRule).toContain(
      "quiet-ledger-settle-in var(--motion-base) var(--motion-ease) both",
    );
    expect(documentRule).toContain(
      "quiet-ledger-document-reveal var(--motion-slow) var(--motion-ease) both",
    );
    expect(motion).toContain("opacity:");
    expect(motion).toContain("translateY(");
    expect(motion).not.toMatch(/translateX|translate3d|scale|height|width/iu);
    expect(`${settleRule}\n${documentRule}`).not.toContain("animation-delay");
  });

  it("removes the pulse and settlement motion immediately for reduced motion", () => {
    const reducedMotion = cssBlock(css, "@media (prefers-reduced-motion: reduce)");
    const quietLedgerReducedMotion = css.slice(
      css.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );

    expect(reducedMotion).toContain("animation: none");
    expect(quietLedgerReducedMotion).toContain(".turn-working-pulse");
    expect(quietLedgerReducedMotion).toContain(
      ".response-turn.is-settling .turn-execution-rail.is-settled",
    );
    expect(quietLedgerReducedMotion).toContain("animation: none");
    expect(quietLedgerReducedMotion).toContain("transform: none");
  });
});
