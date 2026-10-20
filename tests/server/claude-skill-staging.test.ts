// @inertia-test-suite portable
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("discovers and stages skills from an initiative root only when that root is handed in", async () => {
    const root = portableFixtureRoot("Claude initiative skills");
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    writeClaudeSkill(project, "review");
    const initiativeRoot = join(root, "initiative");
    mkdirSync(initiativeRoot);
    const shared = writeClaudeSkill(initiativeRoot, "release-notes");
    const canonicalRoot = realpathSync.native(initiativeRoot);

    expect((await discoverClaudeFilesystemSkills(project, {})).map(({ name }) => name)).toEqual(["review"]);
    expect(await discoverClaudeFilesystemSkills(project, {}, {}, { initiativeSkillsRoot: canonicalRoot })).toEqual([
      expect.objectContaining({ name: "review", scope: "repo" }),
      expect.objectContaining({ name: "release-notes", scope: "initiative", path: shared }),
    ]);

    const selected = [{ source: "claude-native" as const, name: "release-notes", path: shared }];
    await expect(stageClaudeSkillPlugin(selected, project, {})).rejects.toThrow("A selected Claude skill is no longer available.");
    const staged = await stageClaudeSkillPlugin(selected, project, {}, { initiativeSkillsRoot: canonicalRoot });
    try {
      expect(staged!.skillNames).toEqual(["inertia-selected-skills:release-notes"]);
      expect(readFileSync(join(staged!.path, "skills", "release-notes", "SKILL.md"), "utf8"))
        .toContain("Review the repository carefully.");
    } finally {
      await staged!.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("refuses a link at .claude or at a skill folder inside an initiative root when staging", async () => {
    const root = portableFixtureRoot("Claude linked skills inside an initiative");
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const outside = join(root, "outside");
    mkdirSync(outside);
    const escaped = writeClaudeSkill(outside, "escape");

    // `.claude` itself leads out of the initiative's folder.
    const linkedClaude = join(root, "initiative-linked-claude");
    mkdirSync(linkedClaude);
    symlinkSync(join(outside, ".claude"), join(linkedClaude, ".claude"), "dir");
    const viaClaude = join(realpathSync.native(linkedClaude), ".claude", "skills", "escape", "SKILL.md");
    // One skill folder inside `.claude/skills` leads out of it.
    const linkedSkill = join(root, "initiative-linked-skill");
    mkdirSync(join(linkedSkill, ".claude", "skills"), { recursive: true });
    symlinkSync(join(outside, ".claude", "skills", "escape"), join(linkedSkill, ".claude", "skills", "escape"), "dir");
    const viaSkill = join(realpathSync.native(linkedSkill), ".claude", "skills", "escape", "SKILL.md");

    for (const [initiativeSkillsRoot, path] of [
      [realpathSync.native(linkedClaude), viaClaude],
      [realpathSync.native(linkedSkill), viaSkill],
    ] as const) {
      await expect(discoverClaudeFilesystemSkills(project, {}, {}, { initiativeSkillsRoot })).resolves.toEqual([]);
      for (const selected of [path, escaped]) {
        await expect(stageClaudeSkillPlugin([{ source: "claude-native", name: "escape", path: selected }], project, {}, {
          initiativeSkillsRoot,
        })).rejects.toThrow("A selected Claude skill is no longer available.");
      }
    }
  });

  it.skipIf(process.platform === "win32")("refuses an initiative root that is a link or not canonical", async () => {
    const root = portableFixtureRoot("Claude linked initiative skills");
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const outside = join(root, "outside");
    mkdirSync(outside);
    const skill = writeClaudeSkill(outside, "escape");
    const link = join(root, "linked-initiative");
    symlinkSync(outside, link, "dir");

    await expect(discoverClaudeFilesystemSkills(project, {}, {}, { initiativeSkillsRoot: link })).resolves.toEqual([]);
    await expect(discoverClaudeFilesystemSkills(project, {}, {}, { initiativeSkillsRoot: "relative" })).resolves.toEqual([]);
    await expect(stageClaudeSkillPlugin([{ source: "claude-native", name: "escape", path: skill }], project, {}, {
      initiativeSkillsRoot: link,
    })).rejects.toThrow("A selected Claude skill is no longer available.");
  });
});
