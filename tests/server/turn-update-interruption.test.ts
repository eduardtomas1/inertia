// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { queuedRouteIdentity } from "../../src/server/persistence/queued-message-repository";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

async function runningChat(): Promise<{ runtime: TurnControllerTestRuntime; turnId: string }> {
  const runtime = await createTurnControllerTestRuntime();
  const turn = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Refactor the parser." });
  runtime.controller.start(turn.turn.id);
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "native-session" });
  await flushTurnControllerTestPromises();
  return { runtime, turnId: turn.turn.id };
}

function errorTitles(runtime: TurnControllerTestRuntime): string[] {
  return runtime.store.conversationDetail(runtime.conversationId)!.activities
    .filter((activity) => activity.kind === "error").map(({ title }) => title);
}

describe("interrupting running turns for an app update", () => {
  it("settles the turn as interrupted for the update and keeps its native session", async () => {
    const { runtime, turnId } = await runningChat();
    try {
      await expect(runtime.controller.interruptForUpdate([runtime.conversationId], "Codex")).resolves.toBe(true);
      expect(runtime.store.agentTurn(turnId)).toMatchObject({
        status: "interrupted", terminalReason: "app-update", providerSessionAfter: "native-session",
      });
      expect(runtime.store.conversation(runtime.conversationId).providerSessionId).toBe("native-session");
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
      expect(runtime.provider.cancelCount).toBe(1);
      expect(errorTitles(runtime)).toEqual(["Stopped to update Codex."]);
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("names Inertia when the app itself restarts", async () => {
    const { runtime } = await runningChat();
    try {
      await runtime.controller.interruptForUpdate([runtime.conversationId], "Inertia");
      expect(errorTitles(runtime)).toEqual(["Stopped to update Inertia."]);
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("says the chat continues when a continuation plan waits for the interrupted turn", async () => {
    const { runtime, turnId } = await runningChat();
    try {
      runtime.store.restartContinuations.createForConversations([{
        conversationId: runtime.conversationId, interruptedTurnId: turnId,
        routeIdentity: queuedRouteIdentity(runtime.store.conversation(runtime.conversationId)),
      }]);
      await runtime.controller.interruptForUpdate([runtime.conversationId], "Codex and Claude");
      expect(errorTitles(runtime)).toEqual(["Stopped to update Codex and Claude. The chat continues after the update."]);
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("resolves only after the provider cleanup finishes", async () => {
    const { runtime, turnId } = await runningChat();
    try {
      runtime.provider.deferOwnedStop("settled");
      let resolved = false;
      const interrupted = runtime.controller.interruptForUpdate([runtime.conversationId], "Codex").then((value) => {
        resolved = true;
        return value;
      });
      await flushTurnControllerTestPromises();
      expect(runtime.provider.stopOwnedCalls).toHaveLength(1);
      expect(resolved).toBe(false);
      runtime.provider.resolveOwnedStop();
      await expect(interrupted).resolves.toBe(true);
      expect(runtime.store.agentTurn(turnId)).toMatchObject({ status: "interrupted", terminalReason: "app-update" });
    } finally { runtime.provider.resolveOwnedStop(); await runtime.controller.dispose(); runtime.store.close(); }
  });

  it("leaves chats that are not listed or not running alone", async () => {
    const { runtime, turnId } = await runningChat();
    try {
      const before = runtime.store.agentTurn(turnId).status;
      await expect(runtime.controller.interruptForUpdate(["another-conversation"], "Codex")).resolves.toBe(true);
      expect(runtime.store.agentTurn(turnId).status).toBe(before);
      expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
      expect(runtime.provider.cancelCount).toBe(0);
      runtime.provider.resolve({ status: "completed", sessionId: "native-session" });
      await flushTurnControllerTestPromises();
      await runtime.controller.waitForProviderCleanup([runtime.conversationId]);
      await expect(runtime.controller.interruptForUpdate([runtime.conversationId], "Codex")).resolves.toBe(true);
      expect(runtime.store.agentTurn(turnId)).toMatchObject({ status: "completed", terminalReason: "provider-completed" });
    } finally { await runtime.controller.dispose(); runtime.store.close(); }
  });
});
