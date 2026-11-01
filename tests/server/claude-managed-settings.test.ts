// @inertia-test-suite portable
import {
  query as installedClaudeQuery,
  type Options as ClaudeOptions,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  createClaudeAgentSdkHarness,
  readClaudeAgentSdkModels,
  readClaudeAgentSdkSkills,
} from "../../src/server/provider/claude-agent-sdk-harness";
import {
  CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
  CLAUDE_ISOLATED_SKILL_SETTINGS,
} from "../../src/server/provider/claude-skill-plugin";
import {
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { fakeClaudeChild, writeClaudeSkill } from "../helpers/claude-harness-fixture";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const EXPECTED_MANAGED_SETTINGS = {
  disableAllHooks: true,
  disableSkillShellExecution: true,
  disableBundledSkills: true,
  disableClaudeAiConnectors: true,
  syncClaudeAiSkills: false,
  allowedMcpServers: [],
  strictPluginOnlyCustomization: ["skills", "agents", "hooks", "mcp"],
};

async function managedSettingsSentToCli(options: ClaudeOptions): Promise<unknown> {
  const child = fakeClaudeChild();
  let spawned: SpawnOptions | undefined;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  async function* dormantPrompt(): AsyncIterable<SDKUserMessage> {
    await hold;
    yield* [] as SDKUserMessage[];
  }
  const sdk = installedClaudeQuery({
    prompt: dormantPrompt(),
    options: {
      ...options,
      abortController: new AbortController(),
      spawnClaudeCodeProcess: (spawnOptions) => {
        spawned = spawnOptions;
        return child;
      },
    },
  });
  try {
    await expect.poll(() => spawned).toBeDefined();
  } finally {
    release();
    sdk.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const args = spawned!.args;
  const flag = args.indexOf("--managed-settings");
  expect(flag).toBeGreaterThanOrEqual(0);
  expect(args.filter((arg) => arg === "--managed-settings")).toHaveLength(1);
  return JSON.parse(args[flag + 1]!) as unknown;
}

function expectIsolatedManagedSettings(options: ClaudeOptions | undefined): void {
  expect(options?.managedSettings).toBe(CLAUDE_ISOLATED_SKILL_SETTINGS);
  expect(options?.managedSettings).toStrictEqual(EXPECTED_MANAGED_SETTINGS);
  expect(options?.settingSources).toEqual([]);
}

describe("Claude isolated managed settings", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("passes the hook and skill-shell restrictions unchanged to a provider turn", async () => {
    const root = portableFixtureRoot("Claude turn managed settings");
    roots.push(root);
    let captured: ClaudeOptions | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        captured = options;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("init");
          yield claudeSuccessResult("Provider response", "completed");
        })());
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    managers.push(manager);

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-managed-settings",
      cwd: root,
      prompt: "Report the managed settings",
      model: "sonnet",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({ status: "completed" });

    expectIsolatedManagedSettings(captured);
    await expect(managedSettingsSentToCli(captured!))
      .resolves.toStrictEqual(EXPECTED_MANAGED_SETTINGS);
  });

  it("passes the hook and skill-shell restrictions unchanged to metadata discovery", async () => {
    let captured: ClaudeOptions | undefined;
    const models = await readClaudeAgentSdkModels(
      process.execPath,
      {},
      process.cwd(),
      1_000,
      ({ options }) => {
        captured = options;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield* [];
        })(), {
          supportedModels: async () => [{
            value: "sonnet",
            displayName: "Sonnet",
            description: "Balanced model",
          }],
        });
      },
    );

    expect(models.map(({ id }) => id)).toEqual(["sonnet"]);
    expectIsolatedManagedSettings(captured);
    await expect(managedSettingsSentToCli(captured!))
      .resolves.toStrictEqual(EXPECTED_MANAGED_SETTINGS);
  });

  it("passes the hook and skill-shell restrictions unchanged to skill discovery", async () => {
    const root = portableFixtureRoot("Claude skill managed settings");
    roots.push(root);
    writeClaudeSkill(root, "review");
    let captured: ClaudeOptions | undefined;
    const skills = await readClaudeAgentSdkSkills(
      process.execPath,
      {},
      root,
      false,
      1_000,
      ({ options }): Query => {
        captured = options;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield* [];
        })(), {
          supportedCommands: async () => [{
            name: `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:review`,
            description: "Review the repository.",
            argumentHint: "<scope>",
          }],
        });
      },
    );

    expect(skills.map(({ name }) => name)).toEqual(["review"]);
    expectIsolatedManagedSettings(captured);
    await expect(managedSettingsSentToCli(captured!))
      .resolves.toStrictEqual(EXPECTED_MANAGED_SETTINGS);
  });
});
