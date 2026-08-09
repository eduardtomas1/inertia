import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAC_BRAND_MIN_CLEAR_GAP,
  MAC_BRAND_SAFE_INSET,
  MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH,
  MAC_TRAFFIC_LIGHT_POSITION,
} from "../../src/shared/window-chrome";

const appLayout = readFileSync(
  new URL("../../src/renderer/src/components/AppLayout.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("macOS titlebar safe area", () => {
  it("derives the renderer brand inset from the native traffic lights", () => {
    expect(MAC_BRAND_SAFE_INSET).toBe(
      MAC_TRAFFIC_LIGHT_POSITION.x
        + MAC_TRAFFIC_LIGHT_CLUSTER_WIDTH
        + MAC_BRAND_MIN_CLEAR_GAP,
    );
    expect(appLayout).toContain(
      '"--mac-titlebar-brand-safe-inset": `${MAC_BRAND_SAFE_INSET}px`',
    );
    expect(css).toMatch(
      /\.platform-darwin \.sidebar-brand\s*\{[^}]*padding-left:\s*var\(--mac-titlebar-brand-safe-inset\);/su,
    );
  });
});
