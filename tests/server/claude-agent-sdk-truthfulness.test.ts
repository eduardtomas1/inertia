import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { claudeSuccessResult, claudeSystem, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { waitForImmediateCondition } from "../helpers/claude-harness-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude Agent SDK truthfulness boundaries", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  function suspendedRun(
    access: "full" | "supervised",
    conversationId: string,
    callbacks: Parameters<ProviderManager["run"]>[1] = {},
  ) {
    const root = portableFixtureRoot(conversationId);
    roots.push(root);
    let canUseTool: CanUseTool | undefined;
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        canUseTool = options?.canUseTool;
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          await streamGate;
          yield* [];
        })(), { interrupt: async () => { releaseStream(); } });
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    return {
      root,
      manager,
      canUseTool: async (): Promise<CanUseTool> => {
        await waitForImmediateCondition(() => canUseTool !== undefined);
        return canUseTool!;
      },
      run: manager.run(nativeProviderRunInput({
        providerId: "claude",
        conversationId,
        cwd: root,
        prompt: "Wait before using the tool",
        interactionMode: "build",
        access,
      }), callbacks),
    };
  }

  it("denies a late full-access permission callback after cancellation", async () => {
    const value = suspendedRun("full", "claude-cancelled-permission");
    const canUseTool = await value.canUseTool();
    expect(value.manager.cancel("claude-cancelled-permission")).toBe(true);
    await expect(canUseTool("Bash", { command: "npm test" }, {
      signal: new AbortController().signal,
      toolUseID: "late-tool",
      requestId: "late-permission",
    })).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    await expect(value.run).resolves.toMatchObject({ status: "cancelled" });
  });

  it("does not honor an approval whose continuation loses a cancellation race", async () => {
    let requestId = "";
    const value = suspendedRun("supervised", "claude-approval-cancel-race", {
      onApproval: ({ request }) => { requestId = request.requestId; },
    });
    const canUseTool = await value.canUseTool();
    const manager = value.manager;
    const permission = canUseTool("Bash", { command: "npm test" }, {
      signal: new AbortController().signal,
      toolUseID: "racing-tool",
      requestId: "racing-permission",
      title: "Run tests",
    });
    const originalRun = value.run;
    await waitForImmediateCondition(() => requestId.length > 0);
    expect(manager.respondToApproval("claude-approval-cancel-race", requestId, "approve")).toBe(true);
    expect(manager.cancel("claude-approval-cancel-race")).toBe(true);
    await expect(permission).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    await expect(originalRun).resolves.toMatchObject({ status: "cancelled" });
  });

  it("bounds concurrent approval and question callbacks", async () => {
    const approvalRequests: string[] = [];
    const inputRequests: string[] = [];
    const value = suspendedRun("supervised", "claude-bounded-interactions", {
      onApproval: ({ request }) => approvalRequests.push(request.requestId),
      onInput: ({ request }) => inputRequests.push(request.requestId),
    });
    const canUseTool = await value.canUseTool();
    const approvals = Array.from({ length: 65 }, (_, index) => canUseTool(
      "Bash", { command: `echo ${index}` }, {
        signal: new AbortController().signal,
        toolUseID: `approval-tool-${index}`,
        requestId: `approval-${index}`,
        title: `Run command ${index}`,
      },
    ));
    const questions = Array.from({ length: 65 }, (_, index) => canUseTool(
      "AskUserQuestion", {
        questions: [{
          header: "Choice",
          question: `Which choice ${index}?`,
          options: [{ label: "One", description: "First" }],
        }],
      }, {
        signal: new AbortController().signal,
        toolUseID: `question-tool-${index}`,
        requestId: `question-${index}`,
      },
    ));
    await expect(approvals.at(-1)).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    await expect(questions.at(-1)).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(approvalRequests).toHaveLength(64);
    expect(inputRequests).toHaveLength(64);
    expect(value.manager.cancel("claude-bounded-interactions")).toBe(true);
    await Promise.all([...approvals.slice(0, -1), ...questions.slice(0, -1)]);
    await expect(value.run).resolves.toMatchObject({ status: "cancelled" });
  });

  it.each([
    ["different", "session-unrelated"],
    ["missing", undefined],
  ] as const)("rejects a resumed Claude stream with %s session identity", async (_label, actualSessionId) => {
    const root = portableFixtureRoot(`Claude SDK ${_label} resume`);
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield claudeSystem("init", { session_id: actualSessionId });
        yield claudeSuccessResult("Must not be accepted", "completed");
      })()),
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-mismatched-resume",
      cwd: root,
      prompt: "Keep the exact saved context",
      interactionMode: "build",
      access: "supervised",
      sessionId: "session-expected",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("attest the requested provider session"),
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("freezes the first attested Claude session for a new run", async () => {
    const root = portableFixtureRoot("Claude SDK switched new session");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield claudeSystem("init", { session_id: "session-first" });
        yield { ...claudeSuccessResult("Must not switch", "completed"), session_id: "session-second" };
      })()),
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-switched-new-session",
      cwd: root,
      prompt: "Keep one provider session",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("attest the requested provider session"),
    });
  });
});
