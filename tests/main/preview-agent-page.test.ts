import { describe, expect, it } from "vitest";

import { serializeAgentPageSnapshot } from "../../src/main/preview-agent-page";
import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../../src/shared/agent-browser";

describe("agent browser semantic snapshots", () => {
  it("keeps oversized Unicode snapshots valid within the provider byte limit", () => {
    const serialized = serializeAgentPageSnapshot({
      title: "Dense local page",
      url: "http://127.0.0.1:3000/",
      viewport: { width: 1_200, height: 800, scrollX: 0, scrollY: 0 },
      text: "界".repeat(12_000),
      elements: Array.from({ length: 200 }, (_, index) => ({
        ref: `e${index}`,
        role: "button",
        name: "界".repeat(300),
        disabled: false,
        value: "界".repeat(500),
        rect: { x: index, y: index, width: 100, height: 30 },
      })),
      truncated: false,
    });

    expect(Buffer.byteLength(serialized, "utf8"))
      .toBeLessThanOrEqual(MAX_AGENT_BROWSER_TEXT_BYTES);
    expect(() => JSON.parse(serialized)).not.toThrow();
    const parsed = JSON.parse(serialized) as {
      truncated: boolean;
      elements: unknown[];
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.elements.length).toBeGreaterThan(0);
    expect(parsed.elements.length).toBeLessThan(200);
  });
});
