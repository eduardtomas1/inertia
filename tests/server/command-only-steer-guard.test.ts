// @inertia-test-suite portable
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { COMMAND_ONLY_STEER_REFUSED, isCommandOnlyPrompt } from "../../src/shared/follow-up-steer";
import { createDelegationManagerFixture, parsed } from "../support/delegation-manager-fixture";

describe("command-only steer guard (T3 c38537754)", () => {
  it("classifies slash-command-only prompts with no attachments accurately", () => {
    expect(isCommandOnlyPrompt("/context", 0)).toBe(true);
    expect(isCommandOnlyPrompt("  /review-pr 42 ", 0)).toBe(true);
    expect(isCommandOnlyPrompt("/plugin:check", 0)).toBe(true);
    expect(isCommandOnlyPrompt("/context", 1)).toBe(false);
    expect(isCommandOnlyPrompt("Please run /context next", 0)).toBe(false);
    expect(isCommandOnlyPrompt("Normal follow-up", 0)).toBe(false);
    expect(isCommandOnlyPrompt("/", 0)).toBe(false);
  });

  it("drops steerWhenReadyRunId when editing a deferred steer into a command-only prompt", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const itemId = randomUUID();
      f.store.orchestration.queue.enqueue({
        conversationId: f.source.id,
        itemId,
        content: "Normal follow-up",
        steerWhenReadyRunId: f.sourceTurn.runId,
      });
      expect(f.store.orchestration.queue.getItem(itemId)?.steerWhenReadyRunId).toBe(f.sourceTurn.runId);

      // Editing into another normal prompt preserves steerWhenReadyRunId
      f.store.orchestration.queue.edit({
        conversationId: f.source.id,
        itemId,
        expectedRevision: 0,
        content: "Updated normal follow-up",
      });
      expect(f.store.orchestration.queue.getItem(itemId)?.steerWhenReadyRunId).toBe(f.sourceTurn.runId);

      // Editing into a command-only prompt drops steerWhenReadyRunId
      f.store.orchestration.queue.edit({
        conversationId: f.source.id,
        itemId,
        expectedRevision: 1,
        content: "/context",
      });
      expect(f.store.orchestration.queue.getItem(itemId)?.steerWhenReadyRunId).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("queues command-only prompts on managed auto, refuses explicit steer, and moves first without steering on promote_to_steer", async () => {
    const f = await createDelegationManagerFixture();
    try {
      const created = parsed<{ conversationId: string; turnId: string }>(await f.invoke("inertia_create_conversation", {
        title: "Worker",
        prompt: "Running work",
      }));
      const child = f.store.conversation(created.conversationId);
      const childTurn = f.store.agentTurn(created.turnId);
      f.turns.active.set(child.id, { turnId: childTurn.id, runId: childTurn.runId });

      // Explicit steer refuses command-only prompts
      const explicitSteer = await f.invoke("inertia_send_message", {
        conversationId: child.id,
        content: "/context",
        mode: "steer",
      });
      expect(explicitSteer.success).toBe(false);
      expect(explicitSteer.text).toContain(COMMAND_ONLY_STEER_REFUSED);
      expect(f.turns.steers).toHaveLength(0);

      // Auto mode queues a command-only prompt instead of steering
      const autoRes = await f.invoke("inertia_send_message", {
        conversationId: child.id,
        content: "/context",
        mode: "auto",
      });
      expect(autoRes.success, autoRes.text).toBe(true);
      expect(parsed<{ disposition: string }>(autoRes).disposition).toBe("queued");
      expect(f.turns.steers).toHaveLength(0);

      // Enqueue an earlier normal message and then a second command-only message, then promote_to_steer the command-only one
      const earlierId = randomUUID();
      const cmdItemId = randomUUID();
      f.store.orchestration.queue.enqueue({
        conversationId: child.id,
        itemId: earlierId,
        content: "Earlier normal queued message",
      });
      f.store.orchestration.queue.enqueue({
        conversationId: child.id,
        itemId: cmdItemId,
        content: "/compact",
      });

      const promoteRes = await f.invoke("inertia_queue", {
        conversationId: child.id,
        action: "promote_to_steer",
        itemId: cmdItemId,
      });
      expect(promoteRes.success, promoteRes.text).toBe(true);
      const promoted = parsed<{ disposition: string; movedFirst: boolean; message: string }>(promoteRes);
      expect(promoted.disposition).toBe("queued");
      expect(promoted.movedFirst).toBe(true);
      expect(promoted.message).toBe(COMMAND_ONLY_STEER_REFUSED);
      expect(f.turns.steers).toHaveLength(0);
      expect(f.store.orchestration.queue.listActive(child.id)[0]?.id).toBe(cmdItemId);
    } finally {
      await f.close();
    }
  });
});
