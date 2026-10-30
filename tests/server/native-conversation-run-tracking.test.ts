// @inertia-test-suite portable
import { expect, it } from "vitest";
import type { AgentHarnessRun, AgentHarnessStartOptions } from "../../src/server/provider/agent-harness";
import { trackNativeConversationRun } from "../../src/server/provider/native-conversation-run-tracking";
import { providerRunTerminal, type ProviderRunResult } from "../../src/server/provider/contracts";
import { nativeProviderRunInput } from "./model-route-fixture";

function fixture() {
  const options: AgentHarnessStartOptions = {
    input: nativeProviderRunInput({ providerId: "claude", conversationId: "conversation", cwd: process.cwd(),
      prompt: "Continue", interactionMode: "build", access: "supervised", sessionId: "native-session" }),
    environment: {}, executable: process.execPath, providerNativeToolsAvailable: false,
  };
  let settle!: (result: ProviderRunResult) => void;
  const result = new Promise<ProviderRunResult>((resolve) => { settle = resolve; });
  const run: AgentHarnessRun = {
    harnessId: "claude-agent-sdk", providerId: "claude", result, cancel: () => undefined,
    extension: { kind: "cli", providerId: "claude" },
  };
  const terminal: ProviderRunResult = { ...providerRunTerminal(options.input, "completed"),
    text: "done", textTruncated: false, sessionId: "native-session", exitCode: 0, signal: null, cleanupConfirmed: true };
  return { options, run, settle, terminal };
}

it("holds native operation exclusion until late cleanup is affirmatively confirmed", async () => {
  const { options, run, settle, terminal } = fixture();
  const active = new Set<string>();
  let stopped!: (confirmed: boolean) => void;
  const cleanupConfirmation = new Promise<boolean>((resolve) => { stopped = resolve; });
  trackNativeConversationRun(active, options, () => run);
  settle({ ...terminal, cleanupConfirmed: false, cleanupConfirmation });
  await run.result;
  expect(active.has("native-session")).toBe(true);
  stopped(true); await cleanupConfirmation;
  expect(active.has("native-session")).toBe(false);
});

it.each([false, undefined])("keeps exclusion when cleanup proof is %s", async (confirmation) => {
  const { options, run, settle, terminal } = fixture();
  const active = new Set<string>();
  const cleanupConfirmation = confirmation === undefined ? undefined : Promise.resolve(confirmation);
  trackNativeConversationRun(active, options, () => run);
  settle({ ...terminal, cleanupConfirmed: false, cleanupConfirmation });
  await run.result; if (cleanupConfirmation) await cleanupConfirmation;
  expect(active.has("native-session")).toBe(true);
});

it("does not release another live run that announced the same native session", async () => {
  const first = fixture(); const second = fixture(); const active = new Set<string>();
  trackNativeConversationRun(active, first.options, () => first.run);
  trackNativeConversationRun(active, second.options, () => second.run);
  first.settle(first.terminal); await first.run.result;
  expect(active.has("native-session")).toBe(true);
  second.settle(second.terminal); await second.run.result;
  expect(active.size).toBe(0);
});

it("tracks a terminally announced session through uncertain cleanup", async () => {
  const { options, run, settle, terminal } = fixture(); const active = new Set<string>();
  delete options.input.sessionId;
  trackNativeConversationRun(active, options, () => run);
  settle({ ...terminal, cleanupConfirmed: false }); await run.result;
  expect(active.has(terminal.sessionId!)).toBe(true);
});
