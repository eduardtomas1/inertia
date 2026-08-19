import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL(
    "../../src/renderer/src/components/ProviderAuthDialog.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("provider authentication terminal lifecycle", () => {
  it("reapplies current typography after a provider terminal mounts", () => {
    expect(source).toContain(
      "fontSize: latestFontSizeRef.current",
    );
    expect(source).toMatch(
      /\[colorTheme,\s*fontSize,\s*instanceReady,\s*providerId,\s*theme\]/u,
    );
  });
});
