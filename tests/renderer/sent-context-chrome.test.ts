import { describe, expect, it } from "vitest";

import { declarationsFor, parseCssRules, readRendererCss } from "./css-rules";

const provenance = readRendererCss("components/response-timeline/ConversationContextProvenance.css");
const strip = readRendererCss("components/conversation-context/ConversationContextPacketStrip.css");
const rules = parseCssRules([readRendererCss("styles.css"), provenance, strip].join("\n"));

describe("sent context chrome", () => {
  it("shows sent receipts as quiet rows inside the bubble, filled only on hover or while open", () => {
    const receipt = declarationsFor(rules, ".sent-context > span");
    expect(receipt.get("border")).toBe("0");
    expect(receipt.get("background")).toBe("transparent");
    expect(receipt.get("color")).toBe("var(--text-muted)");
    expect(declarationsFor(rules, '.sent-context > button[aria-expanded="true"]').get("background")).toBe("var(--fill)");
    expect(provenance).not.toMatch(/dashed|--accent-strong|--line-strong/u);
  });

  it("draws composer context packets and previews without nested cards or accent text", () => {
    const packet = declarationsFor(rules, ".p-c");
    expect(packet.has("border")).toBe(false);
    expect(packet.has("background")).toBe(false);
    expect(declarationsFor(rules, ".p-m").get("color")).toBe("var(--text-muted)");
    expect(strip).not.toMatch(/--accent-strong|--warning/u);
    const preview = declarationsFor(rules, ".composer-context-preview");
    expect(preview.get("border")).toBe("0");
    expect(preview.get("background")).toBe("var(--fill)");
    const css = readRendererCss("styles.css");
    expect(css).not.toMatch(/\.composer-context-request button:first-child \{[^}]*--accent/u);
    expect(css).not.toMatch(/\.composer-context-request button, \.composer-context-preview button \{/u);
  });
});
