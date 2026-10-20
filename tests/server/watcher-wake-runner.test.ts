import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { WATCHER_SETTLE_DELAY_MS } from "../../src/server/runtime/watcher/watcher-wake-scheduler";
import {
  cleanupWatcherFixtures,
  createWatcherFixture,
  type WatcherFixture,
} from "../support/watcher-runtime-fixture";

afterEach(cleanupWatcherFixtures);

let activitySequence = 0;

function watchedActivity(f: WatcherFixture, label = "Read src/parser.ts", kind: "tool" | "command" = "tool"): void {
  f.provider.emit(f.watched.id, { type: "activity", kind, phase: "completed", label, activityId: `watched-${++activitySequence}` });
}

/** One settled watched activity, then the coalesced check reaches the watcher's provider. */
async function wakeOnce(f: WatcherFixture, linkId: string): Promise<string> {
  const { watcherConversationId } = f.store.watcherLinks.get(linkId)!;
  watchedActivity(f);
  await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
  await vi.waitFor(() => {
    if (!f.provider.runs.has(watcherConversationId)) throw new Error("watcher not running");
  });
  return watcherConversationId;
}

function feed(f: WatcherFixture, linkId: string) {
  return f.watchers.coordinator.feed(linkId).items;
}

function approval(requestId: string, kind: "command" | "file-change") {
  return {
    requestId,
    kind,
    title: kind === "command" ? "Run npm test" : "Edit src/parser.ts",
    permissionRoots: [],
    availableDecisions: ["approve", "deny"] as ("approve" | "deny")[],
  };
}

describe("watcher wake runner", () => {
  it("queues a plan-mode, supervised check with only the context tool and no capability instructions", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      const input = f.provider.input(watcherId);
      expect(input).toMatchObject({ interactionMode: "plan", access: "supervised" });
      expect(input.prompt).toContain("Check 1 for \"Fix the parser\"");
      expect(input.prompt).toContain("[inertia-watcher]");
      expect(input.prompt).not.toContain("Capability pack.");
      expect(f.provider.runs.get(watcherId)!.callbacks.hostTools?.definitions.map(({ name }) => name))
        .toEqual(["inertia_request_context"]);
      expect(f.provider.runs.get(f.watched.id)!.callbacks.hostTools?.definitions.map(({ name }) => name))
        .toContain("inertia_spawn_agent");
      expect(f.store.watcherLinks.get(link.id)!.status).toBe("waking");
      expect(f.store.watcherLinks.wakeForTurn(input.turnId)).toMatchObject({ state: "running", trigger: "activity" });
      expect(f.watcherEvents().some((event) => event.type === "watcher.live" && event.phase === "starting")).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("records a silent receipt, advances the cursor and leaves no checkpoint, artifact or new title", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      const turnId = f.provider.input(watcherId).turnId;
      await f.finishTurn(watcherId, "SILENT");
      const settled = f.store.watcherLinks.get(link.id)!;
      expect(settled.status).toBe("watching");
      expect(settled.cursor.activityAt).not.toBeNull();
      expect(settled.counters).toMatchObject({ wakesTotal: 1, wakesThisTurn: 1, eventsSeen: 1 });
      expect(settled.latest).toMatchObject({ outcome: "silent", text: "" });
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "silent", state: "settled", finding: null, guardState: "skipped" });
      expect(f.checkpoints).not.toContain(turnId);
      expect(f.gitArtifacts).not.toContain(turnId);
      expect(f.store.conversationTitleLocked(watcherId)).toBe(true);
      expect(f.store.conversation(watcherId).title).toBe("Watcher · Reviewer · Fix the parser");
    } finally {
      await f.close();
    }
  });

  it("turns a reply into a finding with a headline, and keeps the cursor when a check fails", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      let watcherId = await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, "- The parser drops the last token in src/parser.ts:42.");
      const afterFinding = f.store.watcherLinks.get(link.id)!;
      expect(afterFinding.latest).toMatchObject({ outcome: "finding", text: "- The parser drops the last token in src/parser.ts:42." });
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "finding", finding: "- The parser drops the last token in src/parser.ts:42." });

      watcherId = await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, null, "failed", { reason: "provider-error", message: "Provider failed." });
      const afterFailure = f.store.watcherLinks.get(link.id)!;
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "failed" });
      expect(afterFailure.cursor).toEqual(afterFinding.cursor);
      expect(afterFailure.status).toBe("watching");
    } finally {
      await f.close();
    }
  });

  it("pauses with usage-limit when the watcher's own turn hits its usage limit", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, null, "failed", { reason: "provider-error", message: "Usage limit reached.", usageLimited: true });
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "usage-limited" });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "usage-limit" });
      expect(f.provider.runs.has(f.watched.id)).toBe(true);
      expect(f.store.conversation(f.watched.id).status).toBe("running");
    } finally {
      await f.close();
    }
  });

  it("runs beside the watched turn without lifting one-run-per-conversation, and merges events while busy", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      expect(f.provider.runs.has(f.watched.id)).toBe(true);
      expect(() => f.controller.queue({ conversationId: f.watched.id, content: "Again" })).toThrow(RuntimeRequestError);
      expect(() => f.controller.queue({ conversationId: watcherId, content: "Question" })).toThrow(RuntimeRequestError);

      watchedActivity(f, "Read src/a.ts");
      watchedActivity(f, "Read src/b.ts");
      watchedActivity(f, "Read src/c.ts");
      await f.advance(10 * 60_000);
      expect(f.provider.inputs.filter((input) => input.conversationId === watcherId)).toHaveLength(1);

      await f.finishTurn(watcherId, "SILENT");
      await f.advance(10 * 60_000);
      await vi.waitFor(() => {
        if (!f.provider.runs.has(watcherId)) throw new Error("second check not running");
      });
      const second = f.provider.input(watcherId);
      expect(second.prompt).toContain("Check 2 for");
      expect(second.prompt).toContain("3 new events");
      expect(f.store.watcherLinks.wakeForTurn(second.turnId)).toMatchObject({ eventsCovered: 3 });
    } finally {
      await f.close();
    }
  });

  it("pauses with wake-budget when mid-turn checks run out and still makes the final check", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ budgets: { wakesPerWatchedTurn: 2, cooldownSeconds: 15, digestKiB: 24, contextReadsPerWake: 4 } });
      await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, "SILENT");
      watchedActivity(f, "Read src/b.ts");
      await f.advance(10 * 60_000);
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "wake-budget" });
      expect(f.provider.runs.has(watcherId)).toBe(false);

      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
      expect(f.store.watcherLinks.wakeForTurn(f.provider.input(watcherId).turnId)).toMatchObject({ trigger: "turn-end" });
      await f.finishTurn(watcherId, "SILENT");
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "wake-budget" });
      expect(f.store.watcherLinks.get(link.id)!.counters.wakesThisTurn).toBe(2);
    } finally {
      await f.close();
    }
  });

  it("counts write attempts and pauses at the second one in the same watched turn", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      let watcherId = await wakeOnce(f, link.id);
      f.provider.emit(watcherId, { type: "approval", request: approval("write-1", "file-change") });
      expect(f.provider.approvals).toContainEqual({ conversationId: watcherId, requestId: "write-1", decision: "deny" });
      await f.finishTurn(watcherId, "SILENT");
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "write-attempt" });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", writeAttemptsThisTurn: 1 });

      watcherId = await wakeOnce(f, link.id);
      f.provider.emit(watcherId, { type: "activity", kind: "tool", phase: "started", label: "Edit", activityId: "edit-1" });
      await f.flush();
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "write-attempt" });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "write-attempts" });
      expect(f.store.agentTurn(feed(f, link.id)[0]!.watcherTurnId!).status).toBe("failed");
    } finally {
      await f.close();
    }
  });

  it("maps a denied command to command-attempt and a question to permission-declined, and counts commands run", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      let watcherId = await wakeOnce(f, link.id);
      f.provider.emit(watcherId, { type: "activity", kind: "command", phase: "completed", label: "rg parser", activityId: "rg-1" });
      f.provider.emit(watcherId, { type: "approval", request: approval("cmd-1", "command") });
      await f.finishTurn(watcherId, "SILENT");
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "command-attempt", commandsRun: 1 });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", commandAttemptsThisTurn: 1 });

      watcherId = await wakeOnce(f, link.id);
      f.provider.emit(watcherId, {
        type: "input",
        request: { requestId: "question-1", questions: [{ id: "q", header: "Q", question: "Which file?", isOther: false, isSecret: false, options: null }] },
      } as never);
      await f.flush();
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "permission-declined" });
      expect(f.store.watcherLinks.get(link.id)!.status).toBe("watching");
    } finally {
      await f.close();
    }
  });
});
