// @inertia-test-suite portable
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
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
    ["context: fork", 'context: "fork"'],
    ["agent: erp-researcher", 'agent: "erp-researcher"'],
    ["Context: fork", null],
    ["AGENT: Explore", null],
  ])("offers and stages a skill that sets %s", async (line, kept) => {
    const root = portableFixtureRoot("Claude delegating skill front matter");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    writeFileSync(skillPath, [
      "---",
      "name: review",
      "description: Review the repository.",
      line,
      "allowed-tools: Bash(rm:*)",
      "---",
      "Run the review.",
    ].join("\n"));

    await expect(discoverClaudeFilesystemSkills(root, {})).resolves.toEqual([
      expect.objectContaining({ name: "review" }),
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
        ...(kept ? [kept] : []),
        "---",
        "Run the review.",
      ].join("\n"));
    } finally {
      await staged!.cleanup();
    }
  });

  it("parses multi-line front matter instead of hiding the skill", async () => {
    const root = portableFixtureRoot("Claude multi-line skill front matter");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    writeFileSync(skillPath, [
      "---",
      "name: review",
      "description: >-",
      "  Review the repository",
      "  before merging.",
      "argument-hint: [scope]",
      "allowed-tools:",
      "  - Bash(git status:*)",
      "  - Read",
      "metadata:",
      "  author: someone",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      "---",
      "Run the review.",
    ].join("\n"));

    await expect(discoverClaudeFilesystemSkills(root, {})).resolves.toEqual([
      expect.objectContaining({
        name: "review",
        description: "Review the repository before merging.",
        argumentHint: "[scope]",
      }),
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
        'description: "Review the repository before merging."',
        'argument-hint: "[scope]"',
        "---",
        "Run the review.",
      ].join("\n"));
    } finally {
      await staged!.cleanup();
    }
  });

  it("stages every discovered skill and keeps the picked ones required", async () => {
    const root = portableFixtureRoot("Claude all skills staging");
    const home = portableFixtureRoot("Claude all skills home");
    roots.push(root, home);
    mkdirSync(join(root, ".git"));
    const picked = writeClaudeSkill(root, "review");
    writeClaudeSkill(root, "shared", "Project copy.");
    writeClaudeSkill(root, "helper");
    writeClaudeSkill(home, "shared", "User copy.");
    const oversized = join(writeClaudeSkill(root, "oversized"), "..");
    for (let index = 0; index < 70; index += 1) {
      writeFileSync(join(oversized, `part-${index}.md`), "x");
    }
    const linked = join(writeClaudeSkill(root, "linked"), "..");
    symlinkSync(join(root, ".git"), join(linked, "escape"), "junction");

    const staged = await stageClaudeSkillPlugin([{
      source: "claude-native",
      name: "review",
      path: picked,
    }], root, { HOME: home }, { includeDiscovered: true });
    try {
      const qualified = (name: string): string => `inertia-selected-skills:${name}`;
      expect(staged!.selectedSkillNames).toEqual([qualified("review")]);
      expect([...staged!.skillNames].sort()).toEqual(
        ["helper", "review", "shared"].map(qualified),
      );
      expect(readFileSync(join(staged!.path, "skills", "shared", "SKILL.md"), "utf8"))
        .toContain("User copy.");
      expect(existsSync(join(staged!.path, "skills", "oversized"))).toBe(false);
      expect(existsSync(join(staged!.path, "skills", "linked"))).toBe(false);
    } finally {
      await staged!.cleanup();
    }
    await expect(stageClaudeSkillPlugin([{
      source: "claude-native",
      name: "linked",
      path: realpathSync(join(linked, "SKILL.md")),
    }], root, { HOME: home }, { includeDiscovered: true }))
      .rejects.toThrow("A selected Claude skill contains a symbolic link.");
  });

  describe("symlinked skill folders", () => {
    function skillFolder(directory: string, name: string, body = "Linked body."): string {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Linked skill.\n---\n${body}`);
      writeFileSync(join(directory, "reference.md"), "Reference.");
      return realpathSync.native(directory);
    }

    function link(target: string, skillsDirectory: string, name: string): void {
      mkdirSync(skillsDirectory, { recursive: true });
      symlinkSync(target, join(skillsDirectory, name), "junction");
    }

    it("discovers, offers, and stages user and project links", async () => {
      const home = realpathSync.native(portableFixtureRoot("Claude linked skills home"));
      const project = realpathSync.native(portableFixtureRoot("Claude linked skills project"));
      roots.push(home, project);
      mkdirSync(join(project, ".git"));
      const userTarget = skillFolder(join(home, ".agents", "skills", "find-skills"), "find-skills");
      link(userTarget, join(home, ".claude", "skills"), "find-skills");
      const projectTarget = skillFolder(join(project, "vendor", "renamed-folder"), "repo-linked");
      link(projectTarget, join(project, ".claude", "skills"), "repo-linked");

      const discovered = await discoverClaudeFilesystemSkills(project, { HOME: home });
      expect(discovered).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "find-skills", scope: "user", path: join(userTarget, "SKILL.md") }),
        expect.objectContaining({ name: "repo-linked", scope: "repo", path: join(projectTarget, "SKILL.md") }),
      ]));
      const staged = await stageClaudeSkillPlugin(
        discovered.filter(({ name }) => name === "find-skills")
          .map(({ name, path }) => ({ source: "claude-native" as const, name, path })),
        project,
        { HOME: home },
        { includeDiscovered: true },
      );
      try {
        expect(staged!.selectedSkillNames).toEqual(["inertia-selected-skills:find-skills"]);
        expect([...staged!.skillNames].sort()).toEqual([
          "inertia-selected-skills:find-skills",
          "inertia-selected-skills:repo-linked",
        ]);
        for (const name of ["find-skills", "repo-linked"]) {
          expect(readFileSync(join(staged!.path, "skills", name, "reference.md"), "utf8")).toBe("Reference.");
        }
      } finally {
        await staged!.cleanup();
      }
    });

    it("refuses nested links, personal or parent targets, and dangling links", async () => {
      const home = realpathSync.native(portableFixtureRoot("Claude refused linked skills home"));
      const project = realpathSync.native(portableFixtureRoot("Claude refused linked skills project"));
      roots.push(home, project);
      mkdirSync(join(project, ".git"));
      const skills = join(project, ".claude", "skills");
      const nested = skillFolder(join(project, "vendor", "nested"), "nested");
      symlinkSync(join(project, ".git"), join(nested, "escape"), "junction");
      link(nested, skills, "nested");
      skillFolder(home, "home-link");
      link(home, skills, "home-link");
      skillFolder(join(project, ".claude"), "parent-link");
      link(join(project, ".claude"), skills, "parent-link");
      skillFolder(join(home, ".claude", "agents"), "config-link");
      link(join(home, ".claude", "agents"), skills, "config-link");
      link(parse(project).root, skills, "root-link");
      link(join(project, "missing"), skills, "dangling");

      const discovered = await discoverClaudeFilesystemSkills(project, { HOME: home });
      expect(discovered.map(({ name }) => name)).toEqual(["nested"]);
      await expect(stageClaudeSkillPlugin([{
        source: "claude-native",
        name: "nested",
        path: discovered[0]!.path,
      }], project, { HOME: home })).rejects.toThrow("A selected Claude skill contains a symbolic link.");
      const staged = await stageClaudeSkillPlugin([], project, { HOME: home }, { includeDiscovered: true });
      expect(staged).toBeNull();
    });

    it("fails revalidation when a link is retargeted after discovery", async () => {
      const project = realpathSync.native(portableFixtureRoot("Claude retargeted linked skill"));
      roots.push(project);
      const skills = join(project, ".claude", "skills");
      const first = skillFolder(join(project, "vendor", "first"), "moving");
      const second = skillFolder(join(project, "vendor", "second"), "moving", "Replaced body.");
      link(first, skills, "moving");
      const [discovered] = await discoverClaudeFilesystemSkills(project, {});
      const selected = [{ source: "claude-native" as const, name: "moving", path: discovered!.path }];
      const staged = await stageClaudeSkillPlugin(selected, project, {});
      await staged!.cleanup();

      rmSync(join(skills, "moving"), { recursive: true, force: true });
      expect(existsSync(join(first, "SKILL.md"))).toBe(true);
      link(second, skills, "moving");

      await expect(stageClaudeSkillPlugin(selected, project, {}))
        .rejects.toThrow("A selected Claude skill is no longer available.");
    });
  });
});
