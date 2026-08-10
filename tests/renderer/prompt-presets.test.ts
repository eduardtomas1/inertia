import { describe, expect, it } from "vitest";

import type { PromptPreset } from "../../src/shared/prompt-presets";
import {
  insertPromptPreset,
  reorderedPromptPresetIds,
} from "../../src/renderer/src/utils/promptPresets";

const presets = ["one", "two", "three"].map((id, position) => ({
  id: `00000000-0000-4000-8000-00000000000${position}`,
  name: id,
  body: id,
  route: null,
  position,
  revision: 1,
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
})) satisfies PromptPreset[];

describe("prompt preset composer utilities", () => {
  it("populates empty prompts and inserts without destroying an existing draft", () => {
    expect(insertPromptPreset("", "Reusable prompt", 0, 0)).toEqual({
      value: "Reusable prompt",
      selectionStart: 15,
      selectionEnd: 15,
    });
    expect(insertPromptPreset("BeforeAfter", "Reusable", 6, 6)).toEqual({
      value: "Before\n\nReusable\n\nAfter",
      selectionStart: 16,
      selectionEnd: 16,
    });
    expect(insertPromptPreset("Replace this", "Preset", 0, 7)?.value)
      .toBe("Preset\n\n this");
  });

  it("returns exact reorder identities and refuses edge moves", () => {
    expect(reorderedPromptPresetIds(presets, presets[1]!.id, "up"))
      .toEqual([presets[1]!.id, presets[0]!.id, presets[2]!.id]);
    expect(reorderedPromptPresetIds(presets, presets[0]!.id, "up"))
      .toBeNull();
    expect(reorderedPromptPresetIds(presets, presets[2]!.id, "down"))
      .toBeNull();
  });
});
