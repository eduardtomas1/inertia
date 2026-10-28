import { afterEach, describe, expect, it } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import type { ProviderActivityEvent } from "../../src/server/provider/contracts";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude compaction activity", () => {
  const managers: ProviderManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  });

  async function compactionActivities(compactResult: "success" | "failed") {
    const manager = ProviderManager.createForTests(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("status", { status: "compacting" });
          yield claudeSystem("status", {
            status: null,
            compact_result: compactResult,
            ...(compactResult === "failed" ? { compact_error: "Compaction rejected" } : {}),
          });
          yield claudeSuccessResult("Done");
        })()),
      })]),
    );
    managers.push(manager);
    const activities: ProviderActivityEvent[] = [];
    await manager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: `claude-compaction-activity-${compactResult}`,
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }), undefined, { onActivity: (event) => activities.push(event) });
    return activities
      .filter(({ label }) => /compact/iu.test(label))
      .map(({ phase, label, activityId }) => ({ phase, label, activityId }));
  }

  it("closes a failed compaction's status row as failed, never as compacted", async () => {
    const activities = await compactionActivities("failed");

    expect(activities).toEqual([
      { phase: "started", label: "Claude is compacting context", activityId: "claude:status:compacting" },
      { phase: "failed", label: "Claude context compaction failed", activityId: "claude:status:compacting" },
    ]);
  });

  it("closes a successful compaction's status row as compacted", async () => {
    const activities = await compactionActivities("success");

    expect(activities).toEqual([
      { phase: "started", label: "Claude is compacting context", activityId: "claude:status:compacting" },
      { phase: "completed", label: "Claude compacted context", activityId: "claude:status:compacting" },
    ]);
  });
});
