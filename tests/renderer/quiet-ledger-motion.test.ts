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
const documentPresenceSource = readFileSync(
  new URL("../../src/renderer/src/hooks/useDocumentPresence.ts", import.meta.url),
  "utf8",
);
const activitySource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/activity.tsx", import.meta.url),
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
    const reducedMotion = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)/gu)]
      .map((match) => cssBlock(css.slice(match.index), "@media"))
      .join("\n");
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

  it("pauses live visual work only when the document is hidden", () => {
    expect(activitySource).toContain("useDocumentVisibility()");
    expect(activitySource).toContain("if (!documentVisible) return;");
    expect(activitySource).toContain("1_000");
    expect(activitySource).not.toContain("document.hasFocus() ? 100 : 1_000");
    expect(documentPresenceSource).toContain('[window, "blur"]');
    expect(activitySource).not.toContain('window.addEventListener("blur", synchronize)');
    expect(appSource).toContain("useDocumentPresence()");
    expect(documentPresenceSource).toContain("useSyncExternalStore(");
    expect(documentPresenceSource).toContain("document.hasFocus()");
    expect(documentPresenceSource).toContain("PRESENCE_EVENTS");
    expect(appLayoutSource).toContain(
      "data-document-visible={documentVisible}",
    );
    expect(activitySource).toContain("memo(function ActivityRow");
    expect(activitySource).toContain("memo(function ActivityGroup");
    expect(activitySource).toContain("const durableStream = useMemo(");
    expect(activitySource).toContain("instead of sorting the complete workstream");
    expect(css).toContain('data-document-visible="false"');
    const backgroundCss = readFileSync(new URL(
      "../../src/renderer/src/background-motion.css", import.meta.url,
    ), "utf8");
    expect(backgroundCss).toContain('data-document-visible="false"');
    expect(backgroundCss).not.toContain("data-document-active");
    expect(backgroundCss).toContain("animation-play-state: paused !important");
    expect(css).toContain("animation-play-state: paused");
    expect(css).toContain("agent-pixel-shimmer");
    expect(css).not.toContain("active-work-tonal-wash");
  });
});
