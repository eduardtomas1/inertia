import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

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

  it("leaves finished turns without a resting footer rule and system notices without a card", () => {
    expect(declarationsFor(rules, ".turn-meta").has("border-top")).toBe(false);
    const system = declarationsFor(rules, ".message.is-system");
    expect(system.get("border")).toBe("0");
    expect(system.get("background")).toBe("transparent");
  });

  it("shows full dates, missing-checkpoint reasons and remote origins in the shared tooltip", () => {
    for (const file of ["metadata.tsx", "layers.tsx", "compatibility.tsx", "MessageOrigin.tsx"]) {
      const source = readFileSync(new URL(`../../src/renderer/src/components/response-timeline/${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/title=\{(?:formatFullDateTime|turn\.checkpointUnavailableReason|providerLabel|`Private Connect)/u);
    }
  });

  it("states changed-file completeness as a plain row, not a filled callout with a stripe", () => {
    const warning = declarationsFor(rules, ".turn-changed-files-warning");
    expect(warning.has("background")).toBe(false);
    expect(warning.has("border-left")).toBe(false);
  });

  it("lists sent attachments as rows on the bubble, not bordered cards with accent tiles", () => {
    const item = declarationsFor(rules, ".sent-attachment");
    expect(item.get("border")).toBe("0");
    expect(item.get("background")).toBe("transparent");
    expect(declarationsFor(rules, ".sent-attachment-thumbnail").has("box-shadow")).toBe(false);
    expect(declarationsFor(rules, ".sent-attachment-thumbnail.is-document").get("color")).toBe("var(--text-muted)");
    expect(declarationsFor(rules, ".sent-attachment-copy strong").get("font-weight")).toBe("500");
  });

  it("marks delegated work with plain status glyphs and text instead of tiles, spinners and badges", () => {
    const mark = declarationsFor(rules, ".subagent-status-mark");
    expect(mark.get("background")).toBe("transparent");
    expect(mark.has("box-shadow")).toBe(false);
    expect(mark.has("border-radius")).toBe(false);
    expect(motion).not.toContain('.subagent-status-mark[data-live="true"]::after');
    expect(declarationsFor(rules, ".goal-panel-subagent-state").has("background")).toBe(false);
    expect(motion).not.toMatch(/subagent[^{}]*\{[^}]*--accent-strong/u);
    const details = declarationsFor(rules, ".subagent-trace-details");
    expect(details.has("background")).toBe(false);
    expect(details.has("border-left")).toBe(false);
  });

  it("sizes the stop action, follow-up rows and legacy disclosure on the shared grid", () => {
    expect(declarationsFor(rules, ".turn-stop-action").get("min-height")).toBe("28px");
    const followUp = declarationsFor(rules, ".turn-follow-up-row");
    expect(followUp.get("border-radius")).toBe("var(--radius-md)");
    expect(declarationsFor(rules, ".turn-follow-up-row > p").get("line-height")).toBe("var(--leading-prose)");
    expect(declarationsFor(rules, ".timeline-follow-controls .icon-button:hover").get("background")).toBe("var(--fill-solid)");
    expect(declarationsFor(rules, "button.turn-agents-line:hover").get("color")).toBe("var(--text)");
    expect(declarationsFor(rules, ".orphan-run-flow > details > summary").get("list-style")).toBe("none");
  });
});
