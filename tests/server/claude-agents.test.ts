// @inertia-test-suite portable
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  claudeAgentDefinition,
  loadClaudeAgents,
} from "../../src/server/provider/claude-agents";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

function fixtureRoot(label: string): string {
  const root = portableFixtureRoot(label);
  roots.push(root);
  return root;
}

function writeAgent(directory: string, file: string, ...lines: string[]): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, file);
  writeFileSync(path, lines.join("\n"));
  return path;
}

function agentFile(name: string, description: string, body = "Research carefully."): string[] {
  return ["---", `name: ${name}`, `description: ${description}`, "---", body];
}

describe("Claude agent loading", () => {
  it("lets the nearest project agent win over the repository and user agents", async () => {
    const repository = fixtureRoot("Claude agent precedence repository");
    const home = fixtureRoot("Claude agent precedence home");
    mkdirSync(join(repository, ".git"));
    const cwd = join(repository, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    writeAgent(join(home, ".claude", "agents"), "researcher.md", ...agentFile("erp-researcher", "user copy"));
    writeAgent(join(home, ".claude", "agents"), "user-only.md", ...agentFile("user-only", "only in the user home"));
    writeAgent(join(repository, ".claude", "agents"), "researcher.md", ...agentFile("erp-researcher", "repository copy"));
    writeAgent(join(repository, ".claude", "agents"), "repo-only.md", ...agentFile("repo-only", "only in the repository"));
    writeAgent(join(cwd, ".claude", "agents"), "nearest.md", ...agentFile("repo-only", "nearest copy"));

    const agents = await loadClaudeAgents(cwd, { HOME: home });

    expect(Object.keys(agents).sort()).toEqual(["erp-researcher", "repo-only", "user-only"]);
    expect(agents["erp-researcher"]?.description).toBe("repository copy");
    expect(agents["repo-only"]?.description).toBe("nearest copy");
    expect(agents["user-only"]).toEqual({
      description: "only in the user home",
      prompt: "Research carefully.",
    });
  });

  it("honours CLAUDE_CONFIG_DIR and reads one level of subdirectories", async () => {
    const project = fixtureRoot("Claude agent config dir project");
    const config = fixtureRoot("Claude agent config dir");
    const agentsDirectory = join(config, "agents");
    writeAgent(join(agentsDirectory, "team"), "nested.md", ...agentFile("nested", "one level down"));
    writeAgent(join(agentsDirectory, "team", "deeper"), "deep.md", ...agentFile("deep", "two levels down"));
    writeAgent(agentsDirectory, "notes.txt", ...agentFile("text", "not markdown"));

    const agents = await loadClaudeAgents(project, {
      HOME: fixtureRoot("Claude agent ignored home"),
      CLAUDE_CONFIG_DIR: config,
    });

    expect(Object.keys(agents)).toEqual(["nested"]);
  });

  it("keeps only the allowed fields and drops permission, hook, memory, and MCP fields", () => {
    const agent = claudeAgentDefinition([
      "---",
      "name: erp-researcher",
      "description: Researches ERP code.\\nUse it for lookups.",
      "tools:",
      "  - Read",
      "  - Grep",
      "  - Bash(git log:*)",
      "disallowedTools: [Write, Edit]",
      "model: Inherit",
      "effort: HIGH",
      "skills: erp-conventions, erp-glossary",
      "maxTurns: 12",
      "memory: project",
      "omitClaudeMd: true",
      "background: true",
      "permissionMode: bypassPermissions",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      "      hooks:",
      "        - type: command",
      "          command: curl evil.example",
      "mcpServers:",
      "  - github:",
      "      command: npx",
      "isolation: worktree",
      "initialPrompt: do something",
      "color: red",
      "---",
      "",
      "You research ERP code.",
      "",
    ].join("\n"), (name) => `inertia-selected-skills:${name}`);

    expect(agent).toEqual({
      name: "erp-researcher",
      definition: {
        description: "Researches ERP code. Use it for lookups.",
        prompt: "You research ERP code.",
        tools: ["Read", "Grep", "Bash(git log:*)"],
        disallowedTools: ["Write", "Edit"],
        model: "inherit",
        effort: "high",
        skills: ["inertia-selected-skills:erp-conventions", "inertia-selected-skills:erp-glossary"],
        maxTurns: 12,
        omitClaudeMd: true,
        background: true,
      },
    });
  });

  it("maps wildcard tools to inherited tools and drops invalid optional values", () => {
    expect(claudeAgentDefinition([
      "---",
      "name: helper",
      "description: Helps.",
      "tools: \"*\"",
      "effort: extreme",
      "maxTurns: -3",
      "memory: everywhere",
      "background: maybe",
      "model: two words",
      "---",
      "Help.",
    ].join("\n"))?.definition).toEqual({ description: "Helps.", prompt: "Help." });
    expect(claudeAgentDefinition([
      "---", "name: numeric", "description: Numeric effort.", "effort: 32000", "tools:", "---", "",
    ].join("\n"))?.definition).toEqual({
      description: "Numeric effort.",
      prompt: "",
      tools: [],
      effort: 32000,
    });
  });

  it.each([
    ["no front matter", ["name: helper", "description: Helps."]],
    ["no name", ["---", "description: Helps.", "---"]],
    ["no description", ["---", "name: helper", "---"]],
    ["a plugin-style name", ["---", "name: plugin:helper", "description: Helps.", "---"]],
    ["a leading dash", ["---", "name: -helper", "description: Helps.", "---"]],
    ["an unparseable tools value", ["---", "name: helper", "description: Helps.", "tools: {Read: true}", "---"]],
    ["an anchored description", ["---", "name: helper", "description: &d Helps.", "---"]],
  ])("rejects an agent file with %s", (_label, lines) => {
    expect(claudeAgentDefinition(lines.join("\n"))).toBeNull();
  });

  it.skipIf(process.platform === "win32")("skips linked directories, oversized, and invalid files without failing", async () => {
    const project = fixtureRoot("Claude agent invalid files");
    const outside = fixtureRoot("Claude agent outside");
    const agentsDirectory = join(project, ".claude", "agents");
    writeAgent(agentsDirectory, "good.md", ...agentFile("good", "valid"));
    writeAgent(agentsDirectory, "broken.md", "---", "name: broken", "description: [unterminated", "---");
    writeAgent(agentsDirectory, "huge.md", ...agentFile("huge", "too large", "x".repeat(300 * 1024)));
    const target = writeAgent(join(project, "shared"), "linked.md", ...agentFile("linked", "elsewhere in the project"));
    symlinkSync(target, join(agentsDirectory, "linked.md"));
    symlinkSync(outside, join(agentsDirectory, "linked-directory"), "junction");

    await expect(loadClaudeAgents(project, {})).resolves.toEqual({
      good: { description: "valid", prompt: "Research carefully." },
      linked: { description: "elsewhere in the project", prompt: "Research carefully." },
    });
  });

  it.skipIf(process.platform === "win32")("follows agent file links only to real Markdown files outside personal locations", async () => {
    const project = fixtureRoot("Claude agent links project");
    const home = fixtureRoot("Claude agent links home");
    const agentsDirectory = join(home, ".claude", "agents");
    const shared = writeAgent(join(home, "dotfiles", "agents"), "shared.md", ...agentFile("shared", "shared agent"));
    const userAgent = writeAgent(agentsDirectory, "user.md", ...agentFile("user-agent", "user agent"));
    const homeRoot = writeAgent(home, "loose.md", ...agentFile("loose", "in the home root"));
    const config = writeAgent(join(home, ".claude", "notes"), "config.md", ...agentFile("config", "config home"));
    const text = writeAgent(join(home, "dotfiles"), "agent.txt", ...agentFile("text", "not markdown"));
    const projectAgents = join(project, ".claude", "agents");
    mkdirSync(projectAgents, { recursive: true });
    symlinkSync(shared, join(projectAgents, "shared.md"));
    symlinkSync(userAgent, join(projectAgents, "user.md"));
    symlinkSync(homeRoot, join(projectAgents, "loose.md"));
    symlinkSync(config, join(projectAgents, "config.md"));
    symlinkSync(text, join(projectAgents, "text.md"));
    symlinkSync(join(home, "missing.md"), join(projectAgents, "dangling.md"));
    symlinkSync(shared, join(agentsDirectory, "shared-from-user.md"));

    const agents = await loadClaudeAgents(project, { HOME: home });

    expect(Object.keys(agents).sort()).toEqual(["shared", "user-agent"]);
  });

  it.skipIf(process.platform === "win32")("follows repository agent links only inside the repository and user links anywhere", async () => {
    const repository = fixtureRoot("Claude agent contained links repository");
    const home = fixtureRoot("Claude agent contained links home");
    const elsewhere = fixtureRoot("Claude agent contained links elsewhere");
    mkdirSync(join(repository, ".git"));
    const cwd = join(repository, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    const vendored = writeAgent(join(repository, "vendor"), "vendored.md", ...agentFile("vendored", "inside the repository"));
    const foreign = writeAgent(elsewhere, "foreign.md", ...agentFile("foreign", "another repository"));
    const personal = writeAgent(join(elsewhere, "personal"), "personal.md", ...agentFile("personal", "user link"));
    const repositoryAgents = join(repository, ".claude", "agents");
    const nearestAgents = join(cwd, ".claude", "agents");
    const userAgents = join(home, ".claude", "agents");
    for (const directory of [repositoryAgents, nearestAgents, userAgents]) {
      mkdirSync(directory, { recursive: true });
    }
    symlinkSync(vendored, join(nearestAgents, "vendored.md"));
    symlinkSync(foreign, join(repositoryAgents, "foreign.md"));
    symlinkSync(foreign, join(nearestAgents, "foreign-nearest.md"));
    symlinkSync(personal, join(userAgents, "personal.md"));

    const agents = await loadClaudeAgents(cwd, { HOME: home });

    expect(Object.keys(agents).sort()).toEqual(["personal", "vendored"]);
  });

  it("bounds the number of agent files it reads", async () => {
    const project = fixtureRoot("Claude agent file bound");
    const agentsDirectory = join(project, ".claude", "agents");
    for (let index = 0; index < 80; index += 1) {
      const name = `agent-${String(index).padStart(2, "0")}`;
      writeAgent(agentsDirectory, `${name}.md`, ...agentFile(name, `agent ${index}`));
    }

    const agents = await loadClaudeAgents(project, {});

    expect(Object.keys(agents)).toHaveLength(64);
    expect(agents["agent-00"]).toBeDefined();
    expect(agents["agent-79"]).toBeUndefined();
  });

  it("stops when the operation is cancelled", async () => {
    const project = fixtureRoot("Claude agent cancellation");
    writeAgent(join(project, ".claude", "agents"), "good.md", ...agentFile("good", "valid"));
    const controller = new AbortController();
    controller.abort(new Error("cancelled for the test"));

    await expect(loadClaudeAgents(project, {}, { signal: controller.signal }))
      .rejects.toThrow("cancelled for the test");
  });
});
