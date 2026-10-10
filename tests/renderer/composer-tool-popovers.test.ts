import { describe, expect, it } from "vitest";

import { declarationsFor, parseCssRules, readRendererCss } from "./css-rules";

const presets = readRendererCss("components/composer/PromptPresetMenu.css");
const base = readRendererCss("styles.css");
const rules = parseCssRules([base, presets].join("\n"));

describe("composer tool popovers", () => {
  it("sizes the presets popover from the composer, not the narrow tools tray", () => {
    const popover = declarationsFor(rules, ".prompt-presets-popover");
    expect(popover.get("width")).not.toContain("100%");
    expect(popover.get("max-width")).not.toContain("100%");
  });

  it("keeps preset rows, fields and buttons on the shared sizes without inner cards", () => {
    expect(declarationsFor(rules, ".composer-popover .prompt-presets-add").get("min-height"))
      .toBe("28px");
    expect(declarationsFor(rules, ".composer-popover .prompt-preset-edit").get("width")).toBe("28px");
    const toggle = declarationsFor(rules, ".prompt-preset-route-toggle");
    expect(toggle.has("border")).toBe(false);
    expect(toggle.has("background")).toBe(false);
    expect(declarationsFor(rules, ".prompt-preset-editor > label:not(.prompt-preset-route-toggle)").get("font-weight"))
      .toBe("500");
    expect(declarationsFor(rules, ".prompt-presets-list").get("border-top")).toBe("1px solid var(--line-soft)");
    expect(declarationsFor(rules, ".prompt-preset-editor-tools").get("border-top")).toBe("1px solid var(--line-soft)");
    expect(declarationsFor(rules, ".composer-popover .prompt-preset-editor-tools > button").has("border")).toBe(false);
  });

  it("separates saved scratch prompts with the soft line and gives each row three columns", () => {
    expect(declarationsFor(rules, ".prompt-stash-list").get("border-top")).toBe("1px solid var(--line-soft)");
    expect(declarationsFor(rules, ".prompt-stash-entry").get("grid-template-columns")).toBe("minmax(0, 1fr) auto 28px");
  });
});
