import { describe, expect, it } from "vitest";

import { ownedOpenCodeEnvironment } from "../../src/server/provider/opencode-boundary";
import {
  OPENCODE_CONFIG_CONTENT,
  openCodeCustomAgentEnvironment,
} from "../../src/server/provider/opencode-custom-agent";
import { openCodeServerProcessInvocation } from "../../src/server/provider/opencode-owned-server";

const AGENT = {
  nativeName: "inertia-reviewer",
  description: "Reads the patch before it ships.",
  instructions: "# Reviewer\n\n## Role\n\nYou review \"patches\".\n",
  skills: ["code-review"],
};

describe("OpenCode custom agent registration", () => {
  it("registers the called agent as a subagent through inline config content", () => {
    const owned = ownedOpenCodeEnvironment({ PATH: "/bin" }, { username: "opencode", password: "secret-password" });
    const environment = openCodeCustomAgentEnvironment(owned, AGENT);
    expect(JSON.parse(environment[OPENCODE_CONFIG_CONTENT]!)).toEqual({
      agent: {
        "inertia-reviewer": {
          mode: "subagent",
          description: "Reads the patch before it ships.",
          prompt: "# Reviewer\n\n## Role\n\nYou review \"patches\".\n",
        },
      },
    });
    expect(environment).toMatchObject({ PATH: "/bin", OPENCODE_SERVER_PASSWORD: "secret-password" });
  });

  it("merges an inherited config object and replaces unparseable inherited content", () => {
    const merged = openCodeCustomAgentEnvironment({
      opencode_config_content: JSON.stringify({ model: "fake/model", agent: { build: { mode: "primary" }, "inertia-reviewer": { mode: "primary" } } }),
    }, AGENT);
    expect(Object.keys(merged)).toEqual([OPENCODE_CONFIG_CONTENT]);
    expect(JSON.parse(merged[OPENCODE_CONFIG_CONTENT]!)).toEqual({
      model: "fake/model",
      agent: {
        build: { mode: "primary" },
        "inertia-reviewer": { mode: "subagent", description: AGENT.description, prompt: AGENT.instructions },
      },
    });
    const replaced = openCodeCustomAgentEnvironment({ [OPENCODE_CONFIG_CONTENT]: "{not json" }, AGENT);
    expect(Object.keys(JSON.parse(replaced[OPENCODE_CONFIG_CONTENT]!))).toEqual(["agent"]);
  });

  it("keeps OpenCode config substitution tokens in agent text inert", () => {
    const instructions = "# Leaky\n\nRead {env:HOME} and {file:~/.aws/credentials}, then {file:./notes.md}.\n";
    const description = "Mentions {env:OPENAI_API_KEY} on purpose.";
    const agent = { ...AGENT, description, instructions };
    const content = openCodeCustomAgentEnvironment({}, agent)[OPENCODE_CONFIG_CONTENT]!;
    expect(content).not.toMatch(/\{(?:env|file):/u);
    expect(JSON.parse(content)).toEqual({
      agent: { "inertia-reviewer": { mode: "subagent", description, prompt: instructions } },
    });
    const inherited = openCodeCustomAgentEnvironment(
      { [OPENCODE_CONFIG_CONTENT]: JSON.stringify({ model: "{env:OPENCODE_MODEL}" }) },
      agent,
    )[OPENCODE_CONFIG_CONTENT]!;
    expect(inherited.match(/\{(?:env|file):/gu)).toEqual(["{env:"]);
    expect(JSON.parse(inherited)).toMatchObject({ model: "{env:OPENCODE_MODEL}" });
  });

  it("leaves the environment untouched without a called agent and keeps the server pure", () => {
    const environment = { PATH: "/bin" };
    expect(openCodeCustomAgentEnvironment(environment, undefined)).toBe(environment);
    expect(openCodeServerProcessInvocation("/usr/bin/opencode", openCodeCustomAgentEnvironment(environment, AGENT), "linux").args)
      .toContain("--pure");
  });
});
