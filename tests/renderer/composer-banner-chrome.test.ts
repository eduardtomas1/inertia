import { describe, expect, it } from "vitest";

import { declarationsFor, parseCssRules, readRendererCss } from "./css-rules";

const banner = readRendererCss("components/composer/LimitResetBanner.css");
const base = readRendererCss("styles.css");
const rules = parseCssRules([base, banner].join("\n"));

describe("composer banner chrome", () => {
  it("gives every banner action the same quiet secondary look", () => {
    const limit = declarationsFor(rules, ".limit-reset-action.secondary-button");
    const maintenance = declarationsFor(rules, ".provider-maintenance-actions > button:not(.icon-button)");
    for (const action of [limit, maintenance]) {
      expect(action.get("border")).toBe("1px solid var(--line)");
      expect(action.get("background")).toBe("transparent");
      expect(action.get("font-size")).toBe("var(--text-xs)");
      expect(action.get("min-height")).toBe("24px");
    }
    expect(declarationsFor(rules, '.limit-reset-action.secondary-button:hover:not([aria-disabled="true"])').get("background"))
      .toBe("var(--fill)");
    expect(banner).toContain("transform: scale(0.97)");
  });

  it("keeps maintenance and quota notices off the accent with readable sizes", () => {
    expect(declarationsFor(rules, ".provider-maintenance-notice > svg").get("color")).toBe("var(--text-muted)");
    expect(declarationsFor(rules, ".provider-maintenance-notice").has("border-left")).toBe(false);
    expect(declarationsFor(rules, ".provider-maintenance-notice small").get("font-size")).toBe("inherit");
    const quota = declarationsFor(rules, ".provider-quota-notice");
    expect(quota.get("grid-template-columns")).toBe("16px minmax(0, 1fr) auto");
    expect(quota.get("min-height")).toBe("44px");
    expect(declarationsFor(rules, ".provider-quota-notice strong").get("font-weight")).toBe("500");
  });

  it("outlines the limit drawer with the composer's soft line", () => {
    expect(declarationsFor(rules, ".limit-reset").get("border")).toBe("1px solid var(--line-soft)");
  });
});
