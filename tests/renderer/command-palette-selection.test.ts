import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../src/renderer/src/components/CommandPalette.tsx", import.meta.url),
  "utf8",
);

describe("command palette selection", () => {
  it("resets search selection and does not let stationary-pointer reflow override it", () => {
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
