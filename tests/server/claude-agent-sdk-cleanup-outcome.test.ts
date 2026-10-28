// @inertia-test-suite portable
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { CLAUDE_ISOLATED_SKILL_PLUGIN_NAME } from "../../src/server/provider/claude-skill-plugin";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import {
  claudeErrorResult,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { fakeClaudeChild, writeClaudeSkill } from "../helpers/claude-harness-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude Agent SDK cleanup outcome", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it.each([
    ["completed", () => claudeSuccessResult("Done", "completed")],
    ["failed", () => claudeErrorResult("error_during_execution", ["The model stopped."])],
  ] as const)("keeps a %s Claude result when only process-tree cleanup is unconfirmed", async (status, terminal) => {
    const root = portableFixtureRoot("Claude SDK cleanup failure");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "cleanup-review");
    let stagedPluginPath = "";
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const terminateProcessTree = vi.fn(async () => false);
    const harness = createClaudeAgentSdkHarness({
      spawnProcess,
      terminateProcessTree,
      createQuery: ({ options }) => {
        stagedPluginPath = options?.plugins?.[0]?.path ?? "";
        options?.spawnClaudeCodeProcess?.({
          command: "/sdk/final/claude",
          args: [],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        });
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("init", {
              plugins: [{
                name: CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
                path: stagedPluginPath,
              }],
              skills: options?.skills,
            });
            yield terminal();
          })(),
        );
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const statuses: string[] = [];

    const result = await manager.run({
      ...nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-cleanup-failure",
        cwd: root,
        prompt: "Complete",
        interactionMode: "build",
        access: "supervised",
      }),
      skills: [{
        source: "claude-native",
        name: "cleanup-review",
        path: skillPath,
      }],
    }, {
      onStatus: ({ status }) => statuses.push(status),
    });
    expect(result).toMatchObject({
      status,
      cleanupConfirmed: false,
      cleanupConfirmation: expect.any(Promise),
    });
    expect(result.error ?? "").not.toContain("could not be confirmed stopped");
    expect(statuses.filter((reported) => reported === "completed" || reported === "failed"))
      .toEqual([status]);
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(child, true);
    expect(stagedPluginPath).not.toBe("");
    expect(existsSync(stagedPluginPath)).toBe(false);
  });
});
