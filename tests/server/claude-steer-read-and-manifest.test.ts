// @inertia-test-suite portable
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE,
  CLAUDE_RETRY_BUDGET_MS,
  createClaudeAgentSdkHarness,
} from "../../src/server/provider/claude-agent-sdk-harness";
import {
  harnessDeclaresCapability,
  PROVIDER_CAPABILITY_IDS,
  providerCapabilityManifest,
} from "../../src/server/provider/capability-manifest";
import * as followUpSteer from "../../src/shared/follow-up-steer";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude Agent SDK onSteerRead & 10-minute retry budget", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("invokes onSteerRead once when Claude reports command_lifecycle started for an accepted follow-up", async () => {
    const root = portableFixtureRoot("claude-steer-read");
    roots.push(root);
    let ready!: () => void;
    const initialConsumed = new Promise<void>((resolve) => { ready = resolve; });
    const readEvents: Array<{ steerId: string; readAt: string }> = [];

    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        const initial = (await iterator.next()).value!;
        ready();
        const followUp = (await iterator.next()).value!;
        yield { ...claudeSuccessResult("First done", "completed"), user_message_uuid: initial.uuid } as SDKMessage;
        // Emit started twice to verify idempotent single notification.
        yield {
          type: "command_lifecycle",
          command_uuid: followUp.uuid,
          state: "started",
          uuid: "lc-1",
          session_id: CLAUDE_PROTOCOL_SESSION_ID,
        } as unknown as SDKMessage;
        yield {
          type: "command_lifecycle",
          command_uuid: followUp.uuid,
          state: "started",
          uuid: "lc-2",
          session_id: CLAUDE_PROTOCOL_SESSION_ID,
        } as unknown as SDKMessage;
        yield { ...claudeSuccessResult("Follow-up done", "completed"), user_message_uuid: followUp.uuid } as SDKMessage;
      })()),
    });

    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-steer-read",
        cwd: root,
        prompt: "Start",
        interactionMode: "build",
        access: "supervised",
      }),
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: true,
      callbacks: {
        onSteerRead: (steerId, readAt) => readEvents.push({ steerId, readAt }),
      },
    });

    await initialConsumed;
    if (run.extension.kind !== "claude-agent-sdk") throw new Error("wrong extension");
    await expect(run.extension.steer!({
      content: "Please also check X",
      imagePaths: [],
      steerId: "steer-abc",
    })).resolves.toBe(true);

    const result = await run.result;
    expect(result).toMatchObject({ status: "completed", text: "Follow-up done", cleanupConfirmed: true });
    expect(readEvents).toHaveLength(1);
    expect(readEvents[0]!.steerId).toBe("steer-abc");
    expect(Date.parse(readEvents[0]!.readAt)).not.toBeNaN();
  });

  it("fails cleanly when Claude stays in an api_retry loop past the retry budget (943de8fe9)", async () => {
    expect(CLAUDE_RETRY_BUDGET_MS).toBe(10 * 60 * 1_000);
    const root = portableFixtureRoot("claude-retry-budget");
    roots.push(root);
    let clock = 1_000;

    const harness = createClaudeAgentSdkHarness({
      retryBudgetMs: 50,
      now: () => clock,
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 500,
          error_status: 529,
          error: "overloaded",
          uuid: "retry-1",
          session_id: CLAUDE_PROTOCOL_SESSION_ID,
        } as unknown as SDKMessage;
        clock += 60;
        yield {
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 500,
          error_status: 529,
          error: "overloaded",
          uuid: "retry-2",
          session_id: CLAUDE_PROTOCOL_SESSION_ID,
        } as unknown as SDKMessage;
      })()),
    });

    const result = await harness.start({
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-retry-budget",
        cwd: root,
        prompt: "Hello",
        interactionMode: "build",
        access: "supervised",
      }),
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: true,
    }).result;

    expect(result).toMatchObject({
      status: "failed",
      error: CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE,
      cleanupConfirmed: true,
      failure: {
        reason: "provider-error",
        terminalEvent: "system/retry-budget-exceeded",
      },
    });
  });

  it("fails cleanly when Claude stalls unanswered after an api_retry without sending more frames", async () => {
    const root = portableFixtureRoot("claude-retry-stall");
    roots.push(root);
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });

    const harness = createClaudeAgentSdkHarness({
      retryBudgetMs: 40,
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 5_000,
          error_status: 503,
          error: "service_unavailable",
          uuid: "retry-stall-1",
          session_id: CLAUDE_PROTOCOL_SESSION_ID,
        } as unknown as SDKMessage;
        await stalled;
      })()),
    });

    const run = harness.start({
      input: nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-retry-stall",
        cwd: root,
        prompt: "Hello",
        interactionMode: "build",
        access: "supervised",
      }),
      executable: process.execPath,
      environment: {},
      providerNativeToolsAvailable: true,
    });

    try {
      const result = await run.result;
      expect(result).toMatchObject({
        status: "failed",
        error: CLAUDE_RETRY_BUDGET_EXCEEDED_MESSAGE,
        cleanupConfirmed: true,
        failure: { terminalEvent: "system/retry-budget-exceeded" },
      });
    } finally {
      release();
    }
  });
});

describe("Manifest steering truth & shared follow-up capability helpers", () => {
  it("publishes steer-accepts-attachments, steer-during-compaction, and native-resume truthfully per harness", () => {
    expect(PROVIDER_CAPABILITY_IDS).toContain("steer-accepts-attachments");
    expect(PROVIDER_CAPABILITY_IDS).toContain("steer-during-compaction");
    expect(PROVIDER_CAPABILITY_IDS).toContain("native-resume");

    const support = (harnessId: Parameters<typeof providerCapabilityManifest>[0], capId: (typeof PROVIDER_CAPABILITY_IDS)[number]) =>
      providerCapabilityManifest(harnessId)!.capabilities.find(({ id }) => id === capId)!.support;

    expect(support("codex-app-server", "native-resume")).toBe("native");
    expect(support("claude-agent-sdk", "native-resume")).toBe("native");
    expect(support("opencode-sdk", "native-resume")).toBe("native");
    expect(support("cursor-sdk", "native-resume")).toBe("native");
    expect(support("pi-rpc", "native-resume")).toBe("unavailable");
    expect(support("antigravity-acp", "native-resume")).toBe("negotiated");
    expect(support("cursor-acp", "native-resume")).toBe("negotiated");
    expect(support("kimi-acp", "native-resume")).toBe("negotiated");
    expect(support("grok-acp", "native-resume")).toBe("negotiated");

    expect(support("codex-app-server", "steer-accepts-attachments")).toBe("native");
    expect(support("claude-agent-sdk", "steer-accepts-attachments")).toBe("native");
    expect(support("pi-rpc", "steer-accepts-attachments")).toBe("native");
    expect(support("opencode-sdk", "steer-accepts-attachments")).toBe("negotiated");
    expect(support("cursor-sdk", "steer-accepts-attachments")).toBe("unavailable");

    expect(support("codex-app-server", "steer-during-compaction")).toBe("native");
    expect(support("claude-agent-sdk", "steer-during-compaction")).toBe("native");
    expect(support("pi-rpc", "steer-during-compaction")).toBe("unavailable");
    expect(support("cursor-sdk", "steer-during-compaction")).toBe("unavailable");

    expect(harnessDeclaresCapability("pi-rpc", "native-resume")).toBe(false);
    expect(harnessDeclaresCapability("codex-app-server", "native-resume")).toBe(true);
  });

  it("removes hardcoded STEERABLE_HARNESS_IDS and derives steerability from the capability contract", () => {
    expect("STEERABLE_HARNESS_IDS" in followUpSteer).toBe(false);
    expect(followUpSteer.supportsActiveParentFollowUp("codex-app-server")).toBe(true);
    expect(followUpSteer.supportsActiveParentFollowUp("claude-agent-sdk")).toBe(true);
    expect(followUpSteer.supportsActiveParentFollowUp("opencode-sdk")).toBe(true);
    expect(followUpSteer.supportsActiveParentFollowUp("pi-rpc")).toBe(true);
    expect(followUpSteer.supportsActiveParentFollowUp("cursor-sdk")).toBe(true);
    expect(followUpSteer.supportsActiveParentFollowUp("cursor-acp")).toBe(false);
    expect(followUpSteer.supportsActiveParentFollowUp("kimi-acp")).toBe(false);
    expect(followUpSteer.supportsActiveParentFollowUp("grok-acp")).toBe(false);
    expect(followUpSteer.supportsActiveParentFollowUp("antigravity-cli")).toBe(false);
    expect(followUpSteer.supportsActiveParentFollowUp("codex-cli")).toBe(false);
    expect(followUpSteer.supportsActiveParentFollowUp(null)).toBe(false);

    expect(followUpSteer.supportsSteerAttachments("codex-app-server")).toBe(true);
    expect(followUpSteer.supportsSteerAttachments("cursor-sdk")).toBe(false);
    expect(followUpSteer.supportsSteerDuringCompaction("codex-app-server")).toBe(true);
    expect(followUpSteer.supportsSteerDuringCompaction("pi-rpc")).toBe(false);
    expect(followUpSteer.supportsNativeResume("codex-app-server")).toBe(true);
    expect(followUpSteer.supportsNativeResume("pi-rpc")).toBe(false);
  });
});
