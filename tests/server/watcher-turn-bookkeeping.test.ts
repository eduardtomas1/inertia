import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeRequestError } from "../../src/server/runtime-errors";
import type { CheckoutFingerprint } from "../../src/server/git/checkout-fingerprint";
import { WATCHER_PENDING_PUBLISH_MS } from "../../src/server/runtime/watcher/watcher-runtime";
import { WATCHER_DISPATCH_FAILURE_LIMIT } from "../../src/server/runtime/watcher/watcher-wake-runner";
import { WATCHER_RETRY_MAX_MS, WATCHER_SETTLE_DELAY_MS } from "../../src/server/runtime/watcher/watcher-wake-scheduler";
import {
  cleanupWatcherFixtures,
  createWatcherFixture,
  type WatcherFixture,
} from "../support/watcher-runtime-fixture";

afterEach(cleanupWatcherFixtures);

let activitySequence = 0;

function watchedActivity(f: WatcherFixture, label: string): void {
  f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label, activityId: `bookkeeping-${++activitySequence}` });
}

async function watcherRunning(f: WatcherFixture, watcherId: string): Promise<void> {
  await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("watcher not running"); });
}

/** The check's own digest, without the restored history of earlier checks. */
function digestOf(prompt: string): string {
  return prompt.split("Structured execution context")[0]!;
}

function watcherInputs(f: WatcherFixture, watcherId: string) {
  return f.provider.inputs.filter(({ conversationId }) => conversationId === watcherId);
}

describe("watcher bookkeeping across overlapping watched turns", () => {
  it("runs the final pass of a turn on that turn after the next one began, and charges nothing to the next", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      const first = await f.startWatchedTurn("First task.");
      watchedActivity(f, "Read src/first.ts");
      await f.finishTurn(f.watched.id, "Done with the first task.");
      // A queued message starts the next turn before the final pass's settle delay ends.
      const second = await f.startWatchedTurn("Second task.");
      expect(f.linkView(link.id).watchedTurnId).toBe(second.id);

      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await watcherRunning(f, watcherId);
      const final = f.provider.input(watcherId);
      expect(f.store.watcherLinks.wakeForTurn(final.turnId)).toMatchObject({ trigger: "turn-end", watchedTurnId: first.id });
      expect(final.prompt).toContain("Final check for this turn: the main chat's turn ended (completed).");
      expect(final.prompt).toContain("Read src/first.ts");
      expect(final.prompt).toContain("Done with the first task.");
      expect(digestOf(final.prompt)).not.toContain("Second task.");
      await f.finishTurn(watcherId, "SILENT");

      expect(f.linkView(link.id)).toMatchObject({
        status: "watching",
        watchedTurnId: second.id,
        finalPassTurnId: first.id,
        cursor: { turnId: second.id, activityAt: null },
        counters: { wakesThisTurn: 0, wakesTotal: 1 },
      });
    } finally {
      await f.close();
    }
  });

  it("never rewinds the cursor when a check settles after the next watched turn began", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      const first = await f.startWatchedTurn("First task.");
      watchedActivity(f, "Read src/first.ts");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
      await watcherRunning(f, watcherId);
      expect(f.provider.input(watcherId).prompt).toContain("Read src/first.ts");

      await f.finishTurn(f.watched.id, "Done with the first task.");
      const second = await f.startWatchedTurn("Second task.");
      await f.finishTurn(watcherId, "SILENT");
      expect(f.linkView(link.id)).toMatchObject({ watchedTurnId: second.id, cursor: { turnId: second.id, activityAt: null } });

      // The first turn's final pass shows only what the in-flight check did not cover.
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await watcherRunning(f, watcherId);
      const final = digestOf(f.provider.input(watcherId).prompt);
      expect(f.store.watcherLinks.wakeForTurn(f.provider.input(watcherId).turnId)).toMatchObject({ trigger: "turn-end", watchedTurnId: first.id });
      expect(final).toContain("0 new events");
      expect(final).toContain("Done with the first task.");
      expect(final).not.toContain("Read src/first.ts");
      expect(final).not.toContain("Second task.");
      await f.finishTurn(watcherId, "SILENT");

      // The second turn is reviewed: its next mid-turn check digests its own work.
      watchedActivity(f, "Read src/second.ts");
      await f.advance(10 * 60_000);
      await watcherRunning(f, watcherId);
      const next = f.provider.input(watcherId);
      expect(f.store.watcherLinks.wakeForTurn(next.turnId)).toMatchObject({ trigger: "activity", watchedTurnId: second.id });
      expect(digestOf(next.prompt)).toContain("Second task.");
      expect(digestOf(next.prompt)).toContain("Read src/second.ts");
      expect(digestOf(next.prompt)).not.toContain("Read src/first.ts");
      expect(f.linkView(link.id).counters.wakesThisTurn).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("takes the pending-event count from the scheduler after checks, failures and retries", async () => {
    let ready = true;
    const f = await createWatcherFixture({ readiness: async () => ready ? null : { ready: false, message: "Sign in to continue." } });
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      await f.startWatchedTurn();
      await f.advance(WATCHER_PENDING_PUBLISH_MS);
      expect(f.linkView(link.id).counters.eventsPending).toBe(1);

      // A turn with no activities: its final pass covers no events and still clears the count.
      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await watcherRunning(f, watcherId);
      expect(f.linkView(link.id).counters.eventsPending).toBe(0);
      expect(f.watcherEvents().at(-1)).toMatchObject({ type: "watcher.link.updated" });
      await f.finishTurn(watcherId, "SILENT");
      expect(f.linkView(link.id).counters).toMatchObject({ eventsPending: 0, eventsSeen: 0 });

      // A transient attempt puts its events back; the check that then fails leaves none waiting.
      await f.startWatchedTurn("Next task.");
      ready = false;
      watchedActivity(f, "Read src/a.ts");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
      expect(watcherInputs(f, watcherId)).toHaveLength(1);
      expect(f.linkView(link.id).counters.eventsPending).toBe(2);
      ready = true;
      await f.advance(WATCHER_RETRY_MAX_MS);
      await watcherRunning(f, watcherId);
      expect(f.linkView(link.id).counters.eventsPending).toBe(0);
      await f.finishTurn(watcherId, null, "failed", { reason: "provider-error", message: "Provider failed." });
      expect(f.linkView(link.id).counters.eventsPending).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("never charges Check now or the initial review to the turn's allowance", async () => {
    const f = await createWatcherFixture();
    try {
      await f.startWatchedTurn("First task.");
      await f.finishTurn(f.watched.id, "Done.");
      const link = await f.attach({ initialReview: true });
      const watcherId = link.watcherConversationId;
      await f.advance(1);
      await watcherRunning(f, watcherId);
      await f.finishTurn(watcherId, "SILENT");
      expect(f.linkView(link.id).counters).toMatchObject({ wakesThisTurn: 0, wakesTotal: 1 });
      await f.startWatchedTurn("Second task.");
      await f.command("watcher.wake", { linkId: link.id });
      await f.advance(1);
      await watcherRunning(f, watcherId);
      await f.finishTurn(watcherId, "SILENT");
      expect(f.watchers.coordinator.feed(link.id).items.map(({ trigger }) => trigger)).toEqual(["manual", "initial"]);
      expect(f.linkView(link.id).counters).toMatchObject({ wakesThisTurn: 0, wakesTotal: 2, wakeAllowance: 12 });
    } finally {
      await f.close();
    }
  });

  it("ends a wake-budget pause when the next watched turn starts", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ budgets: { wakesPerWatchedTurn: 2, cooldownSeconds: 15, digestKiB: 24, contextReadsPerWake: 4 } });
      const watcherId = link.watcherConversationId;
      await f.startWatchedTurn();
      watchedActivity(f, "Read src/a.ts");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
      await watcherRunning(f, watcherId);
      await f.finishTurn(watcherId, "SILENT");
      watchedActivity(f, "Read src/b.ts");
      await f.advance(10 * 60_000);
      expect(f.linkView(link.id)).toMatchObject({ status: "paused", pauseReason: "wake-budget" });
      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await watcherRunning(f, watcherId);
      await f.finishTurn(watcherId, "SILENT");
      expect(f.linkView(link.id)).toMatchObject({ status: "paused", pauseReason: "wake-budget" });

      const next = await f.startWatchedTurn("Next task.");
      expect(f.linkView(link.id)).toMatchObject({
        status: "watching", pauseReason: null, pauseDetail: null, watchedTurnId: next.id,
        counters: { wakesThisTurn: 0, wakeAllowance: 2 },
      });
      expect(f.watcherEvents().at(-1)).toMatchObject({ type: "watcher.link.updated", link: { status: "watching" } });
      watchedActivity(f, "Read src/c.ts");
      await f.advance(10 * 60_000);
      await watcherRunning(f, watcherId);
      expect(f.store.watcherLinks.wakeForTurn(f.provider.input(watcherId).turnId)).toMatchObject({ trigger: "activity", watchedTurnId: next.id });
    } finally {
      await f.close();
    }
  });

  it("returns a budget-paused link to watching when the next turn began during its final pass", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ budgets: { wakesPerWatchedTurn: 2, cooldownSeconds: 15, digestKiB: 24, contextReadsPerWake: 4 } });
      const watcherId = link.watcherConversationId;
      await f.startWatchedTurn();
      f.store.watcherLinks.transition(link.id, ["watching"], { status: "paused", reason: "wake-budget", detail: "Used." }, new Date(f.timers.now).toISOString());
      f.watchers.coordinator.reconcileAfterReady();
      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await watcherRunning(f, watcherId);
      expect(f.linkView(link.id).status).toBe("waking");
      const next = await f.startWatchedTurn("Next task.");
      await f.finishTurn(watcherId, "SILENT");
      expect(f.linkView(link.id)).toMatchObject({ status: "watching", pauseReason: null, watchedTurnId: next.id });
    } finally {
      await f.close();
    }
  });
});

describe("watcher check dispatch and settlement", () => {
  it("pauses after three consecutive dispatch failures instead of retrying forever", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      const queue = f.controller.queue.bind(f.controller);
      let attempts = 0;
      vi.spyOn(f.controller, "queue").mockImplementation((input) => {
        if (input.conversationId !== watcherId) return queue(input);
        attempts += 1;
        throw new RuntimeRequestError("The shared checkout is no longer the project's.");
      });
      await f.startWatchedTurn();
      watchedActivity(f, "Read src/a.ts");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
      for (let retry = 1; retry < WATCHER_DISPATCH_FAILURE_LIMIT; retry += 1) await f.advance(WATCHER_RETRY_MAX_MS);
      expect(attempts).toBe(WATCHER_DISPATCH_FAILURE_LIMIT);
      const paused = f.linkView(link.id);
      expect(paused).toMatchObject({ status: "paused", pauseReason: "route-unavailable" });
      expect(paused.pauseDetail).toContain("The shared checkout is no longer the project's.");
      expect(f.watchers.coordinator.feed(link.id).items.map(({ outcome }) => outcome)).toEqual(["failed", "failed", "failed"]);

      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(30 * 60_000);
      expect(attempts).toBe(WATCHER_DISPATCH_FAILURE_LIMIT);
    } finally {
      await f.close();
    }
  });

  it("does not record a failed check when the user starts a watcher-chat turn during the guard", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let captures = 0;
    const f = await createWatcherFixture({
      captureFingerprint: async () => {
        captures += 1;
        if (captures === 1) await gate;
        return { state: "unavailable", reason: "Not a repository." } as CheckoutFingerprint;
      },
    });
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      await f.startWatchedTurn();
      watchedActivity(f, "Read src/a.ts");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
      expect(captures).toBe(1);
      const question = f.controller.queue({ conversationId: watcherId, content: "What did you find so far?" });
      f.controller.start(question.turn.id);
      await watcherRunning(f, watcherId);
      open();
      await f.flush();
      expect(f.watchers.coordinator.feed(link.id).items).toEqual([]);
      expect(f.linkView(link.id)).toMatchObject({ status: "watching", counters: { wakesTotal: 0 } });
      expect(watcherInputs(f, watcherId).map(({ prompt }) => prompt).join("\n")).toContain("What did you find so far?");
    } finally {
      await f.close();
    }
  });

  it("releases the link and fails the check when settling throws", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      await f.startWatchedTurn();
      watchedActivity(f, "Read src/a.ts");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
      await watcherRunning(f, watcherId);
      vi.spyOn(f.store.watcherLinks, "settleWake").mockImplementationOnce(() => { throw new Error("disk I/O error"); });
      await f.finishTurn(watcherId, "SILENT");
      expect(f.linkView(link.id).status).toBe("watching");
      expect(f.watchers.coordinator.feed(link.id).items[0]).toMatchObject({ state: "settled", outcome: "failed" });

      watchedActivity(f, "Read src/b.ts");
      await f.advance(10 * 60_000);
      await watcherRunning(f, watcherId);
      expect(watcherInputs(f, watcherId)).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
});
