// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import type { ProviderSubagentEvent } from "../../src/server/provider/contracts";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { lifecycleServerSource } from "../helpers/opencode-lifecycle-server";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

async function runStepScenario(
  root: string,
  scenario: "subagent-long-child" | "subagent-concurrent-children",
): Promise<{
  result: Awaited<ReturnType<ProviderManager["run"]>>;
  subagents: ProviderSubagentEvent[];
  activeConversationIds: string[];
}> {
  const command = portableNodeExecutable(root, "opencode");
  writeNodeSubcommand(
    root,
    "serve",
    lifecycleServerSource(root, join(root, "capture.json"), scenario),
  );
  const manager = ProviderManager.createForTests(
    { commands: { opencode: command } },
    new AgentHarnessRegistry([createOpenCodeSdkHarness({
      runDeadlineMs: 30_000,
      eventInactivityDeadlineMs: 5_000,
    })]),
  );
  const subagents: ProviderSubagentEvent[] = [];
  const result = await manager.run(nativeProviderRunInput({
    providerId: "opencode",
    conversationId: `opencode-${scenario}`,
    cwd: root,
    prompt: "Delegate long work",
    interactionMode: "build",
    access: "supervised",
  }), {
    onSubagent: (event) => subagents.push(event),
  });
  return { result, subagents, activeConversationIds: manager.activeConversationIds() };
}

function latest(
  subagents: readonly ProviderSubagentEvent[],
  providerAgentId: string,
): ProviderSubagentEvent | undefined {
  return subagents
    .filter((event) => event.providerAgentId === providerAgentId)
    .at(-1);
}

describe("OpenCode delegated-agent telemetry budgets", () => {
  const roots: string[] = [];

  afterEach(async () => await Promise.all(
    roots.splice(0).map(removePortableFixture),
  ));

  it("completes a run whose child takes more model steps than its usage budget", async () => {
    const root = portableFixtureRoot("OpenCode long delegated child");
    roots.push(root);

    const { result, subagents, activeConversationIds } = await runStepScenario(
      root,
      "subagent-long-child",
    );

    expect(result).toMatchObject({
      status: "completed",
      text: "Parent finished after long delegated work",
      cleanupConfirmed: true,
    });
    const child = latest(subagents, "opencode-step-child-0");
    expect(child).toMatchObject({
      status: "completed",
      isLive: false,
      result: "Child 0 finished.",
      usage: { totalTokens: null, inputTokens: 10, outputTokens: 1 },
    });
    expect(subagents).toContainEqual(expect.objectContaining({
      providerAgentId: "opencode-step-child-0",
      usage: expect.objectContaining({ totalTokens: 2_048 * 11 }),
    }));
    expect(activeConversationIds).toEqual([]);
  }, 40_000);

  it("completes a run with nine concurrent children and exact per-child totals", async () => {
    const root = portableFixtureRoot("OpenCode concurrent delegated children");
    roots.push(root);

    const { result, subagents, activeConversationIds } = await runStepScenario(
      root,
      "subagent-concurrent-children",
    );

    expect(result).toMatchObject({ status: "completed", cleanupConfirmed: true });
    for (let index = 0; index < 9; index += 1) {
      expect(latest(subagents, `opencode-step-child-${index}`)).toMatchObject({
        status: "completed",
        isLive: false,
        result: `Child ${index} finished.`,
        usage: { totalTokens: 230 * 11 },
      });
    }
    expect(activeConversationIds).toEqual([]);
  }, 40_000);
});
