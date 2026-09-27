// @inertia-test-suite portable
import type { spawn } from "node:child_process";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { CLAUDE_PROTOCOL_SESSION_ID, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { fakeClaudeChild } from "../helpers/claude-harness-fixture";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude cancellation settlement", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

  it("releases the exact run after the normal Stop escalation without waiting for SDK EOF", async () => {
    const root = portableFixtureRoot("Claude Stop escalation");
    roots.push(root);
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    const harness = createClaudeAgentSdkHarness({
      terminalSubagentDrainTimeoutMs: 25,
      createQuery: () => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "assistant", session_id: CLAUDE_PROTOCOL_SESSION_ID, parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "Saved answer" }] } } as SDKMessage;
        markWaiting();
        await readReleased;
      })(), { interrupt: () => new Promise(() => {}) }),
    });
    const manager = ProviderManager.createForTests({ commands: { claude: process.execPath }, cancelGraceMs: 10 },
      new AgentHarnessRegistry([harness]));
    const input = nativeProviderRunInput({ providerId: "claude", conversationId: "claude-stop-escalation",
      runId: "stop-run", turnId: "stop-turn", cwd: root, prompt: "Finish", interactionMode: "build", access: "supervised" });
    const result = manager.run(input);
    try {
      await waiting;
      await expect(manager.stopOwned(input.conversationId, { runId: input.runId, turnId: input.turnId! }))
        .resolves.toBe("settled");
      await expect(result).resolves.toMatchObject({ status: "cancelled", text: "Saved answer", cleanupConfirmed: true });
      expect(manager.activeConversationIds()).toEqual([]);
      await expect(manager.stopOwned(input.conversationId, { runId: input.runId, turnId: input.turnId! }))
        .resolves.toBe("settled");
    } finally {
      releaseRead();
      manager.cancel(input.conversationId);
      await result;
    }
  });

  it.each([true, false])("settles a stuck SDK read only after process cleanup is confirmed=%s", async (confirmed) => {
    const root = portableFixtureRoot("Claude stuck cancellation");
    roots.push(root);
    const child = fakeClaudeChild();
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    let completeCleanup!: (value: boolean) => void;
    const cleanup = new Promise<boolean>((resolve) => { completeCleanup = resolve; });
    const terminateProcessTree = vi.fn(() => cleanup);
    const close = vi.fn();
    const harness = createClaudeAgentSdkHarness({
      terminalSubagentDrainTimeoutMs: 25,
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      terminateProcessTree,
      createQuery: ({ options }) => {
        options!.spawnClaudeCodeProcess!({ command: process.execPath, args: [], cwd: root,
          env: {}, signal: options!.abortController!.signal });
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          yield { type: "assistant", session_id: CLAUDE_PROTOCOL_SESSION_ID, parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "The answer is already visible." }] } } as SDKMessage;
          markWaiting();
          // A closed SDK transport need not settle an already-pending read.
          // Neither interrupt nor close releases this synthetic SDK iterator.
          await readReleased;
        })(), { close, interrupt: () => new Promise(() => {}) });
      },
    });
    const run = harness.start({
      input: nativeProviderRunInput({ providerId: "claude", conversationId: "stuck-claude-read",
        cwd: root, prompt: "Finish the request", interactionMode: "build", access: "supervised" }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    });
    let settled = false;
    void run.result.then(() => { settled = true; });
    let timer: NodeJS.Timeout | undefined;
    try {
      await waiting;
      run.cancel(false);
      run.cancel(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(child, true);
      completeCleanup(confirmed);
      const outcome = await Promise.race([
        run.result,
        new Promise<"stalled">((resolve) => { timer = setTimeout(() => resolve("stalled"), 500); }),
      ]);
      expect(outcome).toMatchObject({
        status: confirmed ? "cancelled" : "failed",
        cleanupConfirmed: confirmed,
        text: "The answer is already visible.",
      });
      expect(close).toHaveBeenCalled();
    } finally {
      if (timer) clearTimeout(timer);
      completeCleanup(confirmed);
      releaseRead();
      run.cancel(true);
      await run.result;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });
});
