import { describe, expect, it } from "vitest";

import { declarationsFor, parseCssRules, readRendererCss } from "./css-rules";

const motion = readRendererCss("components/BeautifulUiMotion.css");
const group = readRendererCss("components/response-timeline/ActivityGroup.css");
const base = readRendererCss("styles.css");
const rules = parseCssRules([base, group, motion].join("\n"));

describe("transcript work log chrome", () => {
  it("keeps running rows free of accent pulses and extra spinners", () => {
    expect(base).not.toMatch(/\.agent-activity\.is-running svg \{[^}]*--accent/u);
    expect(base).not.toContain("animation: pulse 1.4s");
    expect(motion).not.toContain(".agent-activity.is-running .agent-activity-icon::after");
    expect(group).not.toContain("activity-group-spin");
    expect(motion).not.toMatch(/\.turn-reasoning-step\.is-active::before \{[^}]*beautiful-spin/u);
  });

  it("tints work log marks with text tiers, not status or info colours, and shows disclosures plainly", () => {
    expect(declarationsFor(rules, ".turn-work-log details > summary svg").get("color")).toBe("var(--text-muted)");
    expect(declarationsFor(rules, ".turn-work-log .agent-activity.is-completed > svg").get("color")).toBe("var(--text-muted)");
    expect(group).not.toContain("--status-completed");
    expect(declarationsFor(rules, ".turn-activity-group .agent-activity-disclosure").has("opacity")).toBe(false);
    expect(declarationsFor(rules, ".turn-thinking-label").get("font-weight")).toBe("500");
  });
});
