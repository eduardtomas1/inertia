import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const stylesheet = (path: string): string => readFileSync(new URL(`../../src/renderer/src/${path}`, import.meta.url), "utf8");

it("styles eagerly rendered Usage controls without waiting for the lazy Limits stylesheet", () => {
  const view = stylesheet("components/UsageView.css");
  const limits = stylesheet("components/UsageLimitsPanel.css");
  const app = stylesheet("styles.css");

  expect(view).toMatch(/\.usage-section-switch\s*\{[^}]*display:\s*flex/su);
  expect(view).toMatch(/\.usage-section-switch button\[aria-pressed="true"\]::after\s*\{[^}]*transform:\s*scaleX\(1\)/su);
  expect(app).toMatch(/\.usage-limits-shortcut\s*\{/su);
  expect(limits).not.toContain(".usage-section-switch");
  expect(limits).not.toContain(".usage-limits-shortcut");
});
