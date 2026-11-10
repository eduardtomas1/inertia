import { describe, expect, it } from "vitest";

import { customAgentDraftFromPreset } from "../../src/renderer/src/components/custom-agents/customAgentDraft";
import { CUSTOM_AGENT_PRESETS } from "../../src/shared/custom-agent-presets";
import {
  compileCustomAgentInstructions,
  customAgentDraftSchema,
  customAgentIconSchema,
  MAX_CUSTOM_AGENT_BLOCK_CHARS,
  MAX_CUSTOM_AGENT_COMPILED_CHARS,
} from "../../src/shared/custom-agents";

describe("custom agent presets", () => {
  it("gives every preset a distinct id and a valid mark, so agents made from presets wear a figure", () => {
    expect(new Set(CUSTOM_AGENT_PRESETS.map((preset) => preset.id)).size).toBe(CUSTOM_AGENT_PRESETS.length);
    expect(Object.fromEntries(CUSTOM_AGENT_PRESETS.map((preset) => [preset.id, [preset.icon, preset.accent]]))).toEqual({
      reviewer: [{ kind: "mark", name: "scout" }, "blue"],
      "test-writer": [{ kind: "mark", name: "guard" }, "green"],
      "docs-writer": [{ kind: "mark", name: "scribe" }, "pink"],
      refactorer: [{ kind: "mark", name: "builder" }, "violet"],
      "security-auditor": [{ kind: "mark", name: "guard" }, "red"],
      "bug-investigator": [{ kind: "mark", name: "scout" }, "orange"],
      "performance-investigator": [{ kind: "mark", name: "spark" }, "amber"],
      "upgrade-planner": [{ kind: "mark", name: "runner" }, "violet"],
      "accessibility-reviewer": [{ kind: "mark", name: "scout" }, "teal"],
    });
    for (const preset of CUSTOM_AGENT_PRESETS) {
      expect(customAgentIconSchema.safeParse(preset.icon).success).toBe(true);
    }
  });

  it.each(CUSTOM_AGENT_PRESETS.map((preset) => [preset.name, preset] as const))("%s is complete and within bounds", (_name, preset) => {
    const kinds = preset.blocks.map((block) => block.kind);
    expect(kinds).toContain("role");
    expect(kinds).toContain("directions");
    expect(kinds).toContain("must");
    expect(kinds).toContain("must-not");
    for (const block of preset.blocks) {
      expect(block.body.trim()).not.toBe("");
      expect(block.body.length).toBeLessThan(MAX_CUSTOM_AGENT_BLOCK_CHARS);
    }
    const compiled = compileCustomAgentInstructions({
      name: preset.name,
      description: preset.summary,
      blocks: preset.blocks.map((block, index) => ({ id: String(index), ...block })),
      skills: [...(preset.skills ?? [])],
    });
    expect(compiled.length).toBeLessThanOrEqual(MAX_CUSTOM_AGENT_COMPILED_CHARS);
    const parsed = customAgentDraftSchema.safeParse(customAgentDraftFromPreset(preset, []));
    expect(parsed.error?.issues ?? []).toEqual([]);
  });
});
