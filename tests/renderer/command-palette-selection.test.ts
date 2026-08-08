import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../src/renderer/src/components/CommandPalette.tsx", import.meta.url),
  "utf8",
);

describe("command palette selection", () => {
  it("focuses synchronously, resets search selection, and ignores stationary-pointer reflow", () => {
    expect(source).toContain("useLayoutEffect");
    expect(source).toContain("searchRef.current?.focus()");
    expect(source).not.toContain("autoFocus");
    expect(source).not.toContain("focusTimer");
    expect(source).toContain(
      "setQuery(event.target.value); setActiveIndex(0);",
    );
    expect(source).toContain(
      "onPointerMove={() => setActiveIndex(index)}",
    );
    expect(source).not.toContain(
      "onMouseEnter={() => setActiveIndex(index)}",
    );
  });
});
