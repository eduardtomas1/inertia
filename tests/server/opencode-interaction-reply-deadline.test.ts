// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  readStableFixtureCapture,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { stalledReplyServerSource, type StalledReplyScenario } from "../helpers/opencode-stalled-reply-server";
import { nativeProviderRunInput } from "./model-route-fixture";

const REPLY_DEADLINE_MS = 300;
const UNSETTLED_REPLY_DEADLINE_MS = 5_000;
const PROMPT_CANCELLATION_MS = 2_000;

describe("OpenCode interaction reply deadlines", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  function stalledReplyRun(
    scenario: StalledReplyScenario,
    access: "supervised" | "full" = "supervised",
    deadlines: { initializationTimeoutMs?: number; runDeadlineMs?: number } = {},
  ) {
    const root = portableFixtureRoot(`OpenCode stalled ${scenario.protocol} ${scenario.interaction}`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", stalledReplyServerSource(root, capturePath, scenario));
    const manager = ProviderManager.createForTests(
      { commands: { opencode: command }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([createOpenCodeSdkHarness({
        initializationTimeoutMs: REPLY_DEADLINE_MS,
        eventInactivityDeadlineMs: 5_000,
        ...deadlines,
      })]),
    );
    const conversationId = `opencode-stalled-${scenario.protocol}-${scenario.interaction}-${access}`;
    const result = manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId,
      cwd: root,
      prompt: "Ask before acting",
      interactionMode: "build",
      access,
    }), {
      onApproval: (event) => {
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve", { runId: event.runId, turnId: event.turnId })).toBe(true);
      },
      onInput: (event) => {
        const questionId = event.request.questions[0]!.id;
        expect(manager.respondToInput(event.conversationId, event.request.requestId, { [questionId]: ["Focused"] }, { runId: event.runId, turnId: event.turnId })).toBe(true);
      },
    });
    const replies = () => readStableFixtureCapture<{
      captured: Array<{ path: string; body?: Record<string, unknown> }>;
    }>(capturePath).captured.filter(({ path }) => path.includes(`/stalled-${scenario.interaction}/`));
    return { manager, conversationId, result, replies };
  }

  it.each([
    ["legacy", "permission"],
    ["v2", "permission"],
    ["legacy", "question"],
    ["v2", "question"],
  ] as const)("fails with a bounded error when a %s %s reply never settles", async (protocol, interaction) => {
    const { result, replies } = stalledReplyRun({ protocol, interaction });

    await expect(result).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining(`Timed out waiting for OpenCode to confirm the ${interaction} reply.`),
    });
    expect(replies()).toHaveLength(1);
  }, 10_000);

  it.each(["legacy", "v2"] as const)("bounds an automatic %s permission reply", async (protocol) => {
    const { result, replies } = stalledReplyRun({ protocol, interaction: "permission" }, "full");

    await expect(result).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("Timed out waiting for OpenCode to confirm the permission reply."),
    });
    expect(replies()).toEqual([expect.objectContaining({ body: { reply: "once" } })]);
  }, 10_000);

  it("keeps the run deadline failure when it aborts an in-flight automatic reply", async () => {
    const { result, replies } = stalledReplyRun(
      { protocol: "legacy", interaction: "permission" },
      "full",
      { initializationTimeoutMs: 8_000, runDeadlineMs: 2_500 },
    );

    await expect(result).resolves.toMatchObject({
      status: "failed",
      error: "OpenCode exceeded the maximum run duration.",
    });
    expect(replies()).toHaveLength(1);
  }, 10_000);

  it.each([
    ["before", REPLY_DEADLINE_MS - 200],
    ["after", REPLY_DEADLINE_MS + 70],
  ] as const)("accepts external resolution %s the reply deadline without resending", async (_timing, externalResolutionMs) => {
    const { result, replies } = stalledReplyRun({ protocol: "v2", interaction: "permission", externalResolutionMs });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(replies()).toEqual([expect.objectContaining({ body: { reply: "once" } })]);
  }, 10_000);

  it("stops promptly while an approval reply is unsettled", async () => {
    const { manager, conversationId, result, replies } = stalledReplyRun(
      { protocol: "legacy", interaction: "permission" },
      "supervised",
      { initializationTimeoutMs: UNSETTLED_REPLY_DEADLINE_MS },
    );

    await waitFor("the approval reply to reach OpenCode", () => replies().length === 1, 8_000);
    const cancelledAt = performance.now();
    expect(manager.cancel(conversationId)).toBe(true);

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(performance.now() - cancelledAt).toBeLessThan(PROMPT_CANCELLATION_MS);
    expect(replies().filter(({ body }) => body?.reply === "once")).toHaveLength(1);
  }, 15_000);
});
