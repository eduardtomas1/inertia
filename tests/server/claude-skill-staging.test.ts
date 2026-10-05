// @inertia-test-suite portable
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stageClaudeSkillPlugin } from "../../src/server/provider/claude-skill-plugin";
import { writeClaudeSkill } from "../helpers/claude-harness-fixture";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";

describe("Claude selected-skill staging", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("stages only the selected skill's name, description and argument hint", async () => {
    const root = portableFixtureRoot("Claude staged skill front matter");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    writeFileSync(skillPath, [
      "---",
      "name: review",
      "description: Review the repository.",
      'argument-hint: "<scope>"',
      "license: MIT",
      "disable-model-invocation: true",
      "---",
      "",
      "Review the repository carefully.",
    ].join("\n"));

    for (const metadataOnly of [false, true]) {
      const staged = await stageClaudeSkillPlugin([{
        source: "claude-native",
        name: "review",
        path: skillPath,
      }], root, {}, { metadataOnly });
      try {
        expect(readFileSync(join(staged!.path, "skills", "review", "SKILL.md"), "utf8")).toBe([
          "---",
          'name: "review"',
          'description: "Review the repository."',
          'argument-hint: "<scope>"',
          "---",
          "",
          "Review the repository carefully.",
        ].join("\n"));
      } finally {
        await staged!.cleanup();
      }
    }
  });

  it.each([
    ["allowed-tools", ["allowed-tools: Bash(rm:*)"]],
    ["hooks", ["hooks:", "  PreToolUse:", "    - matcher: Bash"]],
    ["model", ["model: claude-opus-4-1"]],
    ["context", ["context: fork"]],
  ])("refuses a selected skill that sets %s", async (field, lines) => {
    const root = portableFixtureRoot("Claude refused skill front matter");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    writeFileSync(skillPath, [
      "---",
      "name: review",
      "description: Review the repository.",
      ...lines,
      "---",
      "Run the review.",
    ].join("\n"));

    await expect(stageClaudeSkillPlugin([{
      source: "claude-native",
      name: "review",
      path: skillPath,
    }], root, {})).rejects.toThrow(
      `The Claude skill "review" sets ${field} in SKILL.md, which Inertia does not allow. Remove that field to use the skill.`,
    );
  });
});
