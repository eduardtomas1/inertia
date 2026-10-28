import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("Inertia mark", () => {
  it("stays visible in forced-colors mode, where a masked background would be painted over", () => {
    const pattern = /@media \(forced-colors: active\)\s*\{\s*\.brand-logo,\s*\.welcome-guide-logo\s*\{([^}]*)\}/u;
    const rule = css.match(pattern)?.[1] ?? "";
    expect(rule).toContain("forced-color-adjust: none");
    expect(rule).toContain("background: CanvasText");
  });
});
