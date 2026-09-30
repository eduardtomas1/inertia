import { afterEach, expect, it, vi } from "vitest";

import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises as flushPromises,
  turnControllerTestIdentity as identity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

it("delivers a follow-up sent before the Codex turn reports running", async () => {
  const runtime = await createTurnControllerTestRuntime();
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Keep working until I steer you." });
  runtime.controller.start(queued.turn.id);
  expect(runtime.store.agentTurn(queued.turn.id).status).toBe("starting");
  const providerTurnRunning = () => runtime.store.agentTurn(queued.turn.id).status === "running";
  vi.spyOn(runtime.provider, "steer").mockImplementation(async () => providerTurnRunning());
  const admission = runtime.controller.acquireFollowUpAdmission(runtime.conversationId)!;
  const pendingFollowUp = runtime.controller.steer(admission, {
    content: "Steer with this image.", imagePaths: [],
  });
  await flushPromises();
  expect(runtime.provider.steer).not.toHaveBeenCalled();
  runtime.provider.emit({ ...identity(runtime), type: "status", status: "running" });
  const followedUp = await pendingFollowUp;
  admission.release();
  runtime.provider.resolve();
  await flushPromises();
  expect(runtime.provider.steer).toHaveBeenCalledOnce();
  expect(followedUp).toMatchObject({ role: "user", turnId: queued.turn.id, content: "Steer with this image." });
  runtime.store.close();
});
