import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function forcedColorsRule(path: string, selector: string): string {
  const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
  const media = source.indexOf("@media (forced-colors: active)");
  expect(media, `${path} should have a forced-colors block`).toBeGreaterThanOrEqual(0);
  const start = source.indexOf(`${selector} {`, media);
  expect(start, `${selector} should be styled in forced colors`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
}

function forcedColorsBlock(selector: string): string {
  return forcedColorsRule("../../src/renderer/src/components/settings/settings.css", selector);
}

describe("settings in forced colours", () => {
  it("draws the switch thumb and fills a checked track with system colours", () => {
    const thumb = forcedColorsBlock(".settings-content .switch-thumb");
    expect(thumb).toContain("forced-color-adjust: none");
    expect(thumb).toContain("background: CanvasText");
    const checked = forcedColorsBlock('.settings-content .switch-control[data-checked="true"]');
    expect(checked).toContain("forced-color-adjust: none");
    expect(checked).toContain("background: Highlight");
    expect(forcedColorsBlock('.settings-content .switch-control[data-checked="true"] .switch-thumb')).toContain("background: HighlightText");
  });

  it("draws the selected provider and backend outlines inside their clipped frames", () => {
    for (const [path, selector] of [
      ["../../src/renderer/src/components/settings/ProvidersSettings.css", ".provider-settings-list-row.is-selected"],
      ["../../src/renderer/src/components/ModelBackendsSettings.css", ".backend-profile-rail-item.is-active"],
    ] as const) {
      const rule = forcedColorsRule(path, selector);
      expect(rule).toContain("outline: 1px solid CanvasText");
      expect(rule).toContain("outline-offset: -2px");
    }
  });
});
