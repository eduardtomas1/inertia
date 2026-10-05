// @inertia-test-suite portable
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  discoverClaudeFilesystemSkills,
  stageClaudeSkillPlugin,
} from "../../src/server/provider/claude-skill-plugin";
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
    ["allowed-tools", "allowed-tools: Bash(rm:*)"],
    ["model", "model: claude-opus-4-1"],
    ["Allowed-Tools", "Allowed-Tools: Bash(rm:*)"],
  ])("stages a selected skill without its %s field", async (_field, line) => {
    const root = portableFixtureRoot("Claude stripped skill front matter");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    writeFileSync(skillPath, [
      "---",
      "name: review",
      "description: Review the repository.",
      line,
      "---",
      "Run the review.",
    ].join("\n"));

    expect(await discoverClaudeFilesystemSkills(root, {})).toEqual([
      expect.objectContaining({ name: "review", path: realpathSync(skillPath) }),
    ]);
    const staged = await stageClaudeSkillPlugin([{
      source: "claude-native",
      name: "review",
      path: realpathSync(skillPath),
    }], root, {});
    try {
      expect(readFileSync(join(staged!.path, "skills", "review", "SKILL.md"), "utf8")).toBe([
        "---",
        'name: "review"',
        'description: "Review the repository."',
        "---",
        "Run the review.",
      ].join("\n"));
    } finally {
      await staged!.cleanup();
    }
  });

  it.each([
    ["context", "context: fork"],
    ["agent", "agent: Explore"],
    ["Context", "Context: fork"],
    ["AGENT", "AGENT: Explore"],
  ])("does not offer and refuses a selected skill that sets %s", async (field, line) => {
    const root = portableFixtureRoot("Claude refused skill front matter");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    writeFileSync(skillPath, [
      "---",
      "name: review",
      "description: Review the repository.",
      line,
      "---",
      "Run the review.",
    ].join("\n"));

    await expect(discoverClaudeFilesystemSkills(root, {})).resolves.toEqual([]);
    await expect(stageClaudeSkillPlugin([{
      source: "claude-native",
      name: "review",
      path: realpathSync(skillPath),
    }], root, {})).rejects.toThrow(
      `The Claude skill "review" sets ${field} in SKILL.md, which Inertia does not allow. Remove that field to use the skill.`,
    );
  });
});
