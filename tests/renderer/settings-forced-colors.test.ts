import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/renderer/src/components/settings/settings.css", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");

function forcedColorsBlock(selector: string): string {
  const media = css.indexOf("@media (forced-colors: active)");
  expect(media, "settings.css should have a forced-colors block").toBeGreaterThanOrEqual(0);
  const start = css.indexOf(`${selector} {`, media);
  expect(start, `${selector} should be styled in forced colors`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
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
});
