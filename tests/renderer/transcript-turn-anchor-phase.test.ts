import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const viewportSource = readFileSync(
  new URL(
    "../../src/renderer/src/components/response-timeline/viewport.tsx",
    import.meta.url,
  ),
  "utf8",
);

function effectBlocks(hook: "useEffect" | "useLayoutEffect"): string[] {
  return viewportSource.match(
    new RegExp(
      `${hook}\\(\\(\\) => \\{[\\s\\S]*?\\n  \\}, \\[([\\s\\S]*?)\\n  \\]\\);`,
      "gu",
    ),
  ) ?? [];
}

describe("final answer observation phase contract", () => {
  it("records active lifecycles in layout phase before terminal publication", () => {
    const transitionCall = "advanceFinalAnswerObservation({";
    expect(effectBlocks("useLayoutEffect").some((block) =>
      block.includes(transitionCall))).toBe(true);
    expect(effectBlocks("useEffect").some((block) =>
      block.includes(transitionCall))).toBe(false);
  });
});
