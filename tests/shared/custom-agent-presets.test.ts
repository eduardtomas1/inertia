import { describe, expect, it } from "vitest";

import { customAgentDraftFromPreset } from "../../src/renderer/src/components/custom-agents/customAgentDraft";
import { CUSTOM_AGENT_PRESETS } from "../../src/shared/custom-agent-presets";
import {
  compileCustomAgentInstructions,
  customAgentDraftSchema,
  MAX_CUSTOM_AGENT_BLOCK_CHARS,
  MAX_CUSTOM_AGENT_COMPILED_CHARS,
} from "../../src/shared/custom-agents";

const iconKey = (preset: typeof CUSTOM_AGENT_PRESETS[number]): string =>
  preset.icon.kind === "symbol" ? preset.icon.name : preset.icon.data;

describe("custom agent presets", () => {
  it("gives every preset a distinct id and icon", () => {
    expect(new Set(CUSTOM_AGENT_PRESETS.map((preset) => preset.id)).size).toBe(CUSTOM_AGENT_PRESETS.length);
    expect(new Set(CUSTOM_AGENT_PRESETS.map(iconKey)).size).toBe(CUSTOM_AGENT_PRESETS.length);
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
