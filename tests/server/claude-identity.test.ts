// @inertia-test-suite portable
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Options as ClaudeOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { loadClaudeInstructions } from "../../src/server/provider/claude-memory";
import { CLAUDE_ISOLATED_SKILL_PLUGIN_NAME } from "../../src/server/provider/claude-skill-plugin";
import {
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { writeClaudeSkill } from "../helpers/claude-harness-fixture";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

function fixtureRoot(label: string): string {
  const root = realpathSync.native(portableFixtureRoot(label));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("Claude CLAUDE.md instructions", () => {
  it("appends user instructions and follows imports only inside the config home", async () => {
    const home = fixtureRoot("Claude memory home");
    const project = fixtureRoot("Claude memory project");
    const config = join(home, ".claude");
    write(join(config, "CLAUDE.md"), [
      "USER_MARKER",
      "See @rules-extra/style.md and @~/.claude/deep/one.md",
      "Never @~/secret.md or @../outside.md or @/etc/hostname",
      "```",
      "@code-block.md",
      "```",
      "Inline `@inline.md` code.",
    ].join("\n"));
    write(join(config, "rules-extra", "style.md"), "STYLE_MARKER");
    write(join(config, "code-block.md"), "CODE_BLOCK_MARKER");
    write(join(config, "inline.md"), "INLINE_MARKER");
    write(join(home, "secret.md"), "SECRET_MARKER");
    write(join(home, "outside.md"), "OUTSIDE_MARKER");
    for (let depth = 1; depth <= 7; depth += 1) {
      write(join(config, "deep", `${["", "one", "two", "three", "four", "five", "six", "seven"][depth]}.md`),
        `DEPTH_${depth}_MARKER @${["", "two", "three", "four", "five", "six", "seven", "eight"][depth]}.md`);
    }
    write(join(config, "rules", "always.md"), "ALWAYS_RULE_MARKER");
    write(join(config, "rules", "scoped.md"), "---\npaths:\n  - \"src/**\"\n---\nSCOPED_RULE_MARKER");
    write(join(config, "rules", "team", "nested.md"), "NESTED_RULE_MARKER");

    const { systemPromptAppend } = await loadClaudeInstructions(project, { HOME: home });

    for (const marker of ["USER_MARKER", "STYLE_MARKER", "ALWAYS_RULE_MARKER", "NESTED_RULE_MARKER",
      "DEPTH_1_MARKER", "DEPTH_5_MARKER"]) {
      expect(systemPromptAppend, marker).toContain(marker);
    }
    for (const marker of ["SECRET_MARKER", "OUTSIDE_MARKER", "CODE_BLOCK_MARKER", "INLINE_MARKER",
      "SCOPED_RULE_MARKER", "DEPTH_6_MARKER"]) {
      expect(systemPromptAppend, marker).not.toContain(marker);
    }
    expect(systemPromptAppend).toContain(`Contents of ${join(config, "CLAUDE.md")}`);
  });

  it("leaves the working directory to Claude Code and appends only its ancestors", async () => {
    const home = fixtureRoot("Claude project memory home");
    const repository = fixtureRoot("Claude project memory repository");
    mkdirSync(join(repository, ".git"));
    const cwd = join(repository, "packages", "app");
    write(join(repository, "CLAUDE.md"), "ROOT_MARKER @docs/guide.md @../escape.md");
    write(join(repository, "docs", "guide.md"), "GUIDE_MARKER");
    write(join(repository, "..", "escape.md"), "ESCAPE_MARKER");
    write(join(repository, ".claude", "rules", "rule.md"), "ROOT_RULE_MARKER");
    write(join(repository, "packages", ".claude", "CLAUDE.md"), "PACKAGES_MARKER");
    write(join(cwd, "CLAUDE.md"), "CWD_MARKER");

    const instructions = await loadClaudeInstructions(cwd, { HOME: home });

    expect(instructions.additionalDirectories).toEqual([cwd]);
    const append = instructions.systemPromptAppend;
    expect(append.indexOf("ROOT_MARKER")).toBeLessThan(append.indexOf("PACKAGES_MARKER"));
    expect(append).toContain("GUIDE_MARKER");
    expect(append).toContain("ROOT_RULE_MARKER");
    expect(append).not.toContain("ESCAPE_MARKER");
    expect(append).not.toContain("CWD_MARKER");
  });

  it("never adds the home directory or a Claude config home as a project directory", async () => {
    const home = fixtureRoot("Claude memory personal home");
    mkdirSync(join(home, ".git"));
    write(join(home, "CLAUDE.md"), "HOME_PROJECT_MARKER");
    const configHome = join(home, ".claude");
    const configured = fixtureRoot("Claude memory configured home");
    mkdirSync(join(configHome, "skills"), { recursive: true });
    const nested = join(home, "projects", "plain");
    mkdirSync(nested, { recursive: true });

    for (const [cwd, environment] of [
      [home, { HOME: home }],
      [configHome, { HOME: home }],
      [join(configHome, "skills"), { HOME: home }],
      [configured, { HOME: home, CLAUDE_CONFIG_DIR: configured }],
    ] as const) {
      const instructions = await loadClaudeInstructions(cwd, environment);
      expect(instructions.additionalDirectories, cwd).toEqual([]);
      expect(instructions.systemPromptAppend, cwd).not.toContain("HOME_PROJECT_MARKER");
    }
    const inside = await loadClaudeInstructions(nested, { HOME: home });
    expect(inside.additionalDirectories).toEqual([nested]);
    expect(inside.systemPromptAppend).not.toContain("HOME_PROJECT_MARKER");
  });
});

describe("Claude turn identity in the harness", () => {
  it("passes instructions, filtered agents, every skill, strict MCP, and the CLAUDE.md flag", async () => {
    const home = fixtureRoot("Claude harness identity home");
    const project = fixtureRoot("Claude harness identity project");
    mkdirSync(join(project, ".git"));
    write(join(home, ".claude", "CLAUDE.md"), "USER_IDENTITY_MARKER");
    write(join(home, ".claude", "agents", "researcher.md"), [
      "---",
      "name: erp-researcher",
      "description: Researches ERP code.",
      "permissionMode: bypassPermissions",
      "mcpServers:",
      "  - github:",
      "      command: npx",
      "skills: [delegate]",
      "---",
      "You research.",
    ].join("\n"));
    const picked = writeClaudeSkill(project, "review");
    const delegate = writeClaudeSkill(home, "delegate");
    write(delegate, "---\nname: delegate\ndescription: Delegates.\ncontext: fork\nagent: erp-researcher\n---\nDelegate.");
    let captured: ClaudeOptions | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        captured = options;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("init", {
            plugins: [{ name: CLAUDE_ISOLATED_SKILL_PLUGIN_NAME, path: options!.plugins![0]!.path }],
            skills: [`${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:review`],
          });
          yield claudeSuccessResult("Done", "completed");
        })());
      },
    });

    const run = harness.start({
      input: {
        ...nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-identity",
          cwd: project,
          prompt: "$review",
          interactionMode: "build",
          access: "supervised",
        }),
        skills: [{ source: "claude-native", name: "review", path: picked }],
      },
      executable: process.execPath,
      environment: { HOME: home, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "0" },
      providerNativeToolsAvailable: true,
    });

    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    expect(captured).toMatchObject({
      settingSources: [],
      strictMcpConfig: true,
      additionalDirectories: [project],
      env: expect.objectContaining({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" }),
      skills: [`${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:review`, `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:delegate`],
      agents: {
        "erp-researcher": {
          description: "Researches ERP code.",
          prompt: "You research.",
          skills: [`${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:delegate`],
        },
      },
    });
    expect(captured?.mcpServers).toBeUndefined();
    expect(captured?.agents?.["erp-researcher"]).not.toHaveProperty("permissionMode");
    expect(captured?.agents?.["erp-researcher"]).not.toHaveProperty("mcpServers");
    expect(captured?.additionalDirectories).not.toContain(home);
    expect(captured?.additionalDirectories).not.toContain(join(home, ".claude"));
    expect(captured?.systemPrompt).toMatchObject({
      type: "preset", preset: "claude_code", snapshot: true,
      append: expect.stringContaining("USER_IDENTITY_MARKER"),
    });
  });

  it("starts a turn with no picked skills when the user skills folder cannot be read", async () => {
    const home = fixtureRoot("Claude harness unreadable skills home");
    const project = fixtureRoot("Claude harness unreadable skills project");
    writeClaudeSkill(home, "personal");
    const userSkills = join(home, ".claude", "skills");
    let captured: ClaudeOptions | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        captured = options;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("init", { plugins: [], skills: [] });
          yield claudeSuccessResult("Done", "completed");
        })());
      },
      skillFilesystem: {
        beforeOperation: (operation, path) => {
          if (operation === "opendir" && path === userSkills) {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
        },
      },
    });

    const run = harness.start({
      input: {
        ...nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-identity-unreadable-skills",
          cwd: project,
          prompt: "Hello",
          interactionMode: "build",
          access: "supervised",
        }),
        skills: [],
      },
      executable: process.execPath,
      environment: { HOME: home },
      providerNativeToolsAvailable: true,
    });

    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    expect(captured).toBeDefined();
    expect(captured?.plugins).toBeUndefined();
    expect(captured?.skills).toBeUndefined();
  });

  it("still requires Claude to confirm the picked skills", async () => {
    const project = fixtureRoot("Claude harness picked skill confirmation");
    const picked = writeClaudeSkill(project, "review");
    writeClaudeSkill(project, "other");
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield claudeSystem("init", {
          plugins: [{ name: CLAUDE_ISOLATED_SKILL_PLUGIN_NAME, path: options!.plugins![0]!.path }],
          skills: [`${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:other`],
        });
        yield claudeSuccessResult("Done", "completed");
      })()),
    });

    const run = harness.start({
      input: {
        ...nativeProviderRunInput({
          providerId: "claude",
          conversationId: "claude-identity-picked",
          cwd: project,
          prompt: "$review",
          interactionMode: "build",
          access: "supervised",
        }),
        skills: [{ source: "claude-native", name: "review", path: picked }],
      },
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: true,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("selected isolated skills"),
    });
  });
});
