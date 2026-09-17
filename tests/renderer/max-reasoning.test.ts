import { describe, expect, it } from "vitest";
import { isMaximumReasoning } from "../../src/renderer/src/utils/maxReasoning";

function model(levels: string[], defaultReasoningEffort = "") {
  return { reasoningOptions: levels.map((value) => ({ value, label: value, description: "" })), defaultReasoningEffort };
}

describe("maximum reasoning frame", () => {
  it.each([
    ["Codex", ["low", "medium", "high", "xhigh", "ultra"], "ultra"],
    ["Claude", ["max", "low", "medium", "high"], "max"],
    ["Cursor", ["low", "high"], "high"],
    ["Kimi", ["medium", "high"], "high"],
    ["Antigravity", ["low", "high"], "high"],
    ["OpenCode", ["xhigh", "high", "medium", "low"], "xhigh"],
  ])("uses the %s model's supported maximum independent of catalog order", (_, levels, max) => {
    expect(isMaximumReasoning(model(levels), ` ${max.toUpperCase()} `)).toBe(true);
    expect(isMaximumReasoning(model(levels), "low")).toBe(false);
    expect(isMaximumReasoning(model(levels, max), null)).toBe(true);
  });
  it("does not guess at unsupported, disabled, or arbitrary named variants", () => {
    expect(isMaximumReasoning(undefined, "ultra")).toBe(false);
    expect(isMaximumReasoning(model(["low", "high"]), "ultra")).toBe(false);
    expect(isMaximumReasoning(model(["none", "disabled", "creative"]), "creative")).toBe(false);
    expect(isMaximumReasoning(model([]), null)).toBe(false);
  });
});
