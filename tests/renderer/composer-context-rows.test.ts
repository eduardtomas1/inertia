import { describe, expect, it } from "vitest";

import { declarationsFor, parseCssRules, readRendererCss } from "./css-rules";

const source = readRendererCss(
  "styles.css",
  "components/composer/ComposerCommandMenu.css",
  "components/composer/ComposerSendActions.css",
);
const rules = parseCssRules(source);

describe("composer context rows", () => {
  it("draws selection and preview context as plain rows without stripes, dashes or accent text", () => {
    for (const selector of [".composer-context", ".composer-preview-context"]) {
      const row = declarationsFor(rules, selector);
      expect(row.get("border"), selector).toBe("0");
      expect(row.get("color"), selector).toBe("var(--text-muted)");
      expect(row.get("background"), selector).toBe("transparent");
      expect(row.has("border-left"), selector).toBe(false);
    }
    expect(source).not.toMatch(/\.composer-(?:preview-)?context[^{}]*\{[^}]*(?:dashed|--accent-strong)/u);
    expect(declarationsFor(rules, ".composer-preview-context-toggle:hover").get("background")).toBe("var(--fill)");
  });

  it("shows route readiness and attachment progress as status text, not badges", () => {
    for (const selector of [".route-readiness-badge", ".provider-status"]) {
      const status = declarationsFor(rules, selector);
      expect(status.has("border"), selector).toBe(false);
      expect(status.has("background"), selector).toBe(false);
      expect(status.get("font-weight"), selector).toBe("500");
    }
  });

  it("keeps LoadingMark's spin as the only composer loader and drops icon tiles", () => {
    expect(source).not.toContain("composer-status-dots");
    expect(declarationsFor(rules, ".composer-compact-notice-icon").has("background")).toBe(false);
    expect(declarationsFor(rules, '.send-button[data-motion-state="sending"] .composer-send-motion-icon').get("animation"))
      .toBe(declarationsFor(rules, ".loading-mark").get("animation"));
    expect(source).not.toMatch(/\.send-button-loading:disabled\s*\{[^}]*--accent-strong/u);
  });

  it("leaves the float shadow to the composer surface, not its toolbar rows", () => {
    for (const selector of [".composer-toolbar", ".composer-primary-rail"]) {
      expect(declarationsFor(rules, selector).has("box-shadow"), selector).toBe(false);
    }
  });
});
