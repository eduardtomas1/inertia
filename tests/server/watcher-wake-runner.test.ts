import { randomUUID } from "node:crypto";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientCommand } from "../../src/shared/contracts";

import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { WATCHER_FINAL_PASS_RETRY_LIMIT, WATCHER_ROUTE_RETRY_LIMIT } from "../../src/server/runtime/watcher/watcher-wake-runner";
import {
  WATCHER_ACCUMULATE_AGE_COOLDOWNS,
  WATCHER_ACCUMULATE_MIN,
  WATCHER_RETRY_MAX_MS,
  WATCHER_SETTLE_DELAY_MS,
} from "../../src/server/runtime/watcher/watcher-wake-scheduler";
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
  await f.advance(WATCHER_SETTLE_DELAY_MS + WATCHER_ACCUMULATE_AGE_COOLDOWNS * 60_000);
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
      expect(input.prompt).toContain("Main chat (Codex · gpt-test): turn running for ");
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
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "finding", finding: "- The parser drops the last token in src/parser.ts:42.", delivery: null });

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

  it("keeps a check's usage-limit pause when the user paused and resumed during the check", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      await f.command("watcher.pause", { linkId: link.id });
      await f.command("watcher.resume", { linkId: link.id });
      expect(f.store.watcherLinks.get(link.id)!.status).toBe("watching");
      await f.finishTurn(watcherId, null, "failed", { reason: "provider-error", message: "Usage limit reached.", usageLimited: true });
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "usage-limited" });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "usage-limit" });

      await f.command("watcher.resume", { linkId: link.id });
      await wakeOnce(f, link.id);
      expect(f.provider.inputs.filter((input) => input.conversationId === watcherId)).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("makes a usage-limited final pass again after Resume", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      const watchedTurn = await f.startWatchedTurn();
      watchedActivity(f);
      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
      await f.finishTurn(watcherId, null, "failed", { reason: "provider-error", message: "Usage limit reached.", usageLimited: true });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "usage-limit", finalPassTurnId: null });
      await f.advance(30 * 60_000);
      expect(f.provider.runs.has(watcherId)).toBe(false);

      await f.command("watcher.resume", { linkId: link.id });
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass after Resume"); });
      expect(f.store.watcherLinks.wakeForTurn(f.provider.input(watcherId).turnId)).toMatchObject({
        trigger: "turn-end", watchedTurnId: watchedTurn.id,
      });
      await f.finishTurn(watcherId, "SILENT");
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", finalPassTurnId: watchedTurn.id });
    } finally {
      await f.close();
    }
  });

  it("retries a failed final pass a bounded number of times, and never a cancelled one", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      const first = await f.startWatchedTurn("A");
      watchedActivity(f);
      await f.finishTurn(f.watched.id, "Done A.");
      for (let attempt = 0; attempt <= WATCHER_FINAL_PASS_RETRY_LIMIT; attempt += 1) {
        await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
        await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error(`no final pass attempt ${attempt}`); });
        expect(f.store.watcherLinks.wakeForTurn(f.provider.input(watcherId).turnId)).toMatchObject({ trigger: "turn-end", watchedTurnId: first.id });
        await f.finishTurn(watcherId, null, "failed", { reason: "provider-error", message: "The provider stopped." });
      }
      await f.advance(30 * 60_000);
      expect(f.provider.runs.has(watcherId)).toBe(false);
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", finalPassTurnId: first.id });
      expect(feed(f, link.id).map(({ outcome }) => outcome)).toEqual(Array(WATCHER_FINAL_PASS_RETRY_LIMIT + 1).fill("failed"));

      const second = await f.startWatchedTurn("B");
      watchedActivity(f);
      await f.finishTurn(f.watched.id, "Done B.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass of B"); });
      await f.finishTurn(watcherId, null, "cancelled");
      await f.advance(30 * 60_000);
      expect(f.provider.runs.has(watcherId)).toBe(false);
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", finalPassTurnId: second.id });
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
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "silent" });
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

  it("reports write-attempt for a check the runner stopped at the second write attempt of the watched turn", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      let watcherId = await wakeOnce(f, link.id);
      f.provider.emit(watcherId, { type: "approval", request: approval("write-1", "file-change") });
      await f.finishTurn(watcherId, "SILENT");
      watcherId = await wakeOnce(f, link.id);
      f.provider.emit(watcherId, { type: "approval", request: approval("write-2", "file-change") });
      await f.flush();
      expect(f.provider.cancelled).toContain(watcherId);
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "write-attempt" });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "write-attempts" });
    } finally {
      await f.close();
    }
  });

  it("counts a second denied edit request in one check as the second write attempt and pauses", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      f.provider.emit(watcherId, { type: "approval", request: approval("write-1", "file-change") });
      f.provider.emit(watcherId, { type: "approval", request: approval("write-2", "file-change") });
      await f.flush();
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "write-attempt" });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({
        status: "paused", pauseReason: "write-attempts", writeAttemptsThisTurn: 2,
      });
    } finally {
      await f.close();
    }
  });

  it("keeps a check that continued after a declined command quiet, maps a question to permission-declined, and counts only commands that ran", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      let watcherId = await wakeOnce(f, link.id);
      f.provider.emit(watcherId, { type: "activity", kind: "command", phase: "completed", label: "rg parser", activityId: "rg-1" });
      f.provider.emit(watcherId, { type: "approval", request: approval("cmd-1", "command") });
      f.provider.emit(watcherId, { type: "activity", kind: "command", phase: "started", label: "npm test", activityId: "npm-1" });
      f.provider.emit(watcherId, { type: "activity", kind: "command", phase: "failed", label: "npm test", activityId: "npm-1" });
      await f.finishTurn(watcherId, "SILENT");
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "silent", commandsRun: 1, commandsDeclined: 1 });
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

  it("retries an unready route three times, then pauses with route-unavailable until the route is ready", async () => {
    let ready = true;
    const readiness = vi.fn(async () => ready ? null : { ready: false, message: "Sign in to continue." });
    const f = await createWatcherFixture({ readiness });
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      await f.startWatchedTurn();
      const watcherRuns = () => f.provider.inputs.filter((input) => input.conversationId === watcherId).length;
      const failAttempts = async (attempts: number): Promise<void> => {
        const before = readiness.mock.calls.length;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          await f.advance(WATCHER_RETRY_MAX_MS);
          expect(readiness.mock.calls.length - before).toBe(attempt);
        }
      };

      // Three transient retries keep the link watching, and a ready route starts the check.
      ready = false;
      watchedActivity(f);
      await failAttempts(WATCHER_ROUTE_RETRY_LIMIT);
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", pauseReason: null });
      ready = true;
      await f.advance(WATCHER_RETRY_MAX_MS);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("watcher not running"); });
      await f.finishTurn(watcherId, "SILENT");
      expect(watcherRuns()).toBe(1);

      // The started check reset the count: three more retries, then the fourth failure pauses.
      ready = false;
      for (let index = 0; index < WATCHER_ACCUMULATE_MIN; index += 1) watchedActivity(f, `Read src/b${index}.ts`);
      await failAttempts(WATCHER_ROUTE_RETRY_LIMIT);
      expect(f.store.watcherLinks.get(link.id)!.status).toBe("watching");
      await failAttempts(1);
      const paused = f.store.watcherLinks.get(link.id)!;
      expect(paused).toMatchObject({ status: "paused", pauseReason: "route-unavailable" });
      expect(paused.pauseDetail).toBe(
        "The watcher's route (codex-app-server harness · OpenAI · gpt-test) isn't ready: Sign in to continue. "
        + "Check Settings → Agents; it can resume once the route is ready.",
      );
      expect(f.watcherEvents()).toContainEqual({
        type: "watcher.link.updated",
        link: expect.objectContaining({ id: link.id, status: "paused", pauseReason: "route-unavailable", pauseDetail: paused.pauseDetail }),
      });

      // Paused: no further retries, and resume waits for a ready route.
      const callsWhilePaused = readiness.mock.calls.length;
      await f.advance(10 * 60_000);
      expect(readiness.mock.calls.length).toBe(callsWhilePaused);
      expect(watcherRuns()).toBe(1);
      await expect(f.command("watcher.resume", { linkId: link.id })).rejects.toThrow("route isn't ready");
      ready = true;
      await expect(f.command("watcher.resume", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { status: "watching", pauseReason: null } } });
      await wakeOnce(f, link.id);
      expect(watcherRuns()).toBe(2);
    } finally {
      await f.close();
    }
  });

  it("keeps the final pass that an unready route paused and runs it after Resume", async () => {
    let ready = true;
    const f = await createWatcherFixture({ readiness: async () => ready ? null : { ready: false, message: "Sign in to continue." } });
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      const watchedTurn = await f.startWatchedTurn();
      ready = false;
      await f.finishTurn(f.watched.id, "Done.");
      for (let attempt = 0; attempt <= WATCHER_ROUTE_RETRY_LIMIT + 1; attempt += 1) {
        await f.advance(WATCHER_SETTLE_DELAY_MS + WATCHER_RETRY_MAX_MS);
      }
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "route-unavailable", finalPassTurnId: null });
      ready = true;
      await f.command("watcher.resume", { linkId: link.id });
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
      expect(f.store.watcherLinks.wakeForTurn(f.provider.input(watcherId).turnId)).toMatchObject({
        trigger: "turn-end", watchedTurnId: watchedTurn.id,
      });
      await f.finishTurn(watcherId, "SILENT");
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", finalPassTurnId: watchedTurn.id });
    } finally {
      await f.close();
    }
  });

  it("keeps a final pass that the user paused, or paused and resumed, while it waited for the turn's diff", async () => {
    for (const resumeAtOnce of [true, false]) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const turnDiff = vi.fn(async () => {
        await gate;
        return { patchState: "available" as const, truncated: false, patch: "", files: [] };
      });
      const f = await createWatcherFixture({ turnDiff });
      try {
        const link = await f.attach();
        const watcherId = link.watcherConversationId;
        const watchedTurn = await f.startWatchedTurn();
        await f.finishTurn(f.watched.id, "Done.");
        await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
        await vi.waitFor(() => { if (turnDiff.mock.calls.length === 0) throw new Error("no diff read"); });
        expect(f.watcherEvents().filter((event) => event.type === "watcher.link.updated").at(-1)).toMatchObject({ link: { status: "waking" } });
        await expect(f.command("watcher.wake", { linkId: link.id })).rejects.toThrow("The watcher is already checking.");
        await f.command("watcher.pause", { linkId: link.id });
        if (resumeAtOnce) await f.command("watcher.resume", { linkId: link.id });
        release();
        await f.flush();
        await f.advance(10 * 60_000);
        if (!resumeAtOnce) {
          expect(f.provider.runs.has(watcherId)).toBe(false);
          await f.command("watcher.resume", { linkId: link.id });
          await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
        }
        await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
        expect(f.store.watcherLinks.wakeForTurn(f.provider.input(watcherId).turnId)).toMatchObject({
          trigger: "turn-end", watchedTurnId: watchedTurn.id,
        });
        await f.finishTurn(watcherId, "SILENT");
        expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", finalPassTurnId: watchedTurn.id });
      } finally {
        await f.close();
      }
    }
  });

  it("quotes the turn's diff on the final pass and never reads it for a mid-turn check", async () => {
    const turnDiff = vi.fn(async (_turnId: string) => ({
      patchState: "available" as const,
      truncated: false,
      patch: "diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -40,3 +40,3 @@\n context\n-  return tokens.slice(0, -1);\n+  return tokens;\n",
      files: [{ path: "src/parser.ts", status: "M", insertions: 1, deletions: 1, untracked: false, staged: false, unstaged: true, indexStatus: " ", worktreeStatus: "M" }],
    }));
    const f = await createWatcherFixture({ turnDiff });
    try {
      const link = await f.attach();
      const watchedTurn = await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      expect(f.provider.input(watcherId).prompt).not.toContain("## Changed files");
      await f.finishTurn(watcherId, "SILENT");
      expect(turnDiff).not.toHaveBeenCalled();

      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
      expect(turnDiff).toHaveBeenCalledWith(watchedTurn.id);
      expect(f.provider.input(watcherId).prompt).toContain([
        "## Changed files — quoted evidence (unified diff)",
        "> - M src/parser.ts (+1 −1)",
        "> @@ -40,3 +40,3 @@",
        ">  context",
        "> -  return tokens.slice(0, -1);",
        "> +  return tokens;",
      ].join("\n"));
      await f.finishTurn(watcherId, "SILENT");
    } finally {
      await f.close();
    }
  });

  it("reminds each check of this turn's earlier findings and marks the ones a later check reports resolved", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      let watcherId = await wakeOnce(f, link.id);
      expect(f.provider.input(watcherId).prompt).not.toContain("## Your earlier findings");
      await f.finishTurn(watcherId, "- The parser drops the last token.");

      watcherId = await wakeOnce(f, link.id);
      expect(f.provider.input(watcherId).prompt).toMatch(
        /## Your earlier findings this turn\n- Check 1 \(\d{2}:\d{2}\): The parser drops the last token\. — not sent\n/u,
      );
      await f.finishTurn(watcherId, "- The lexer skips tabs.\n\nResolved: check 1, check 7");
      const [second, first] = feed(f, link.id);
      expect(first).toMatchObject({ sequence: 1, outcome: "finding", resolvedBySequence: 2 });
      expect(second).toMatchObject({ sequence: 2, outcome: "finding", finding: "- The lexer skips tabs.", resolvedBySequence: null });
      expect(f.store.watcherLinks.get(link.id)!.latest).toMatchObject({ outcome: "finding", text: "- The lexer skips tabs." });

      watcherId = await wakeOnce(f, link.id);
      expect(f.provider.input(watcherId).prompt).toMatch(
        /- Check 1 \(\d{2}:\d{2}\): The parser drops the last token\. — not sent; resolved by check 2\n- Check 2 \(\d{2}:\d{2}\): The lexer skips tabs\. — not sent/u,
      );
      await f.finishTurn(watcherId, "SILENT\nResolved: check 2");
      expect(feed(f, link.id)[0]).toMatchObject({ sequence: 3, outcome: "silent", finding: null });
      expect(feed(f, link.id)[1]).toMatchObject({ sequence: 2, resolvedBySequence: 3 });
      expect(f.watcherEvents().filter((event) => event.type === "watcher.link.updated").length).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });

  it("marks checks resolved by a reply that is only a Resolved line, as a silent check", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      let watcherId = await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, "- The parser drops the last token.");
      watcherId = await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, "Resolved: check 1");
      expect(feed(f, link.id)[0]).toMatchObject({ sequence: 2, outcome: "silent", finding: null });
      expect(feed(f, link.id)[1]).toMatchObject({ sequence: 1, resolvedBySequence: 2 });
      expect(f.store.watcherLinks.get(link.id)!.counters.findingsTotal).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("queues an automatic watcher's finding behind the running turn without steering", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ delivery: "auto" });
      await f.startWatchedTurn();
      const watcherId = await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, "- The parser drops the last token.");
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "finding", delivery: { mode: "queue", state: "queued" } });
      expect(f.store.queuedMessages.list(f.watched.id)).toMatchObject([{ content: "- The parser drops the last token." }]);
      expect(f.provider.steerCalls).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("starts the idle main chat's next turn with an automatic final finding, but never auto-sends from that turn", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ delivery: "auto" });
      const watcherId = link.watcherConversationId;
      const finalPass = async (reply: string) => {
        await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
        await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
        await f.finishTurn(watcherId, reply);
      };
      await f.startWatchedTurn();
      await f.finishTurn(f.watched.id, "Done.");
      await finalPass("- The parser drops the last token.");
      await vi.waitFor(() => { if (!f.provider.runs.has(f.watched.id)) throw new Error("note turn not started"); });
      expect(f.provider.input(f.watched.id).prompt).toContain("[inertia-watcher-note]");
      expect(feed(f, link.id)[0]).toMatchObject({ delivery: { mode: "queue", state: "sent" } });

      await f.finishTurn(f.watched.id, "Fixed.");
      await finalPass("- The fix misses the empty input.");
      expect(feed(f, link.id)[0]).toMatchObject({ outcome: "finding", finding: "- The fix misses the empty input.", delivery: null });
      expect(f.provider.runs.has(f.watched.id)).toBe(false);
      expect(f.store.queuedMessages.list(f.watched.id)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("leaves an automatic finding for a manual send when the main chat's queue is full", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ delivery: "auto" });
      await f.startWatchedTurn();
      for (const content of ["One", "Two", "Three"]) {
        await f.queue.handler(null as unknown as WebSocket, {
          type: "message.queue.enqueue", requestId: randomUUID(),
          payload: { conversationId: f.watched.id, id: randomUUID(), content, attachments: [] },
        } as ClientCommand);
      }
      const watcherId = await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, "- The parser drops the last token.");
      expect(feed(f, link.id)[0]).toMatchObject({
        outcome: "finding",
        delivery: { mode: "queue", state: "failed", detail: expect.stringContaining("queue is full") },
      });
      expect(f.store.watcherLinks.get(link.id)!.status).toBe("watching");
    } finally {
      await f.close();
    }
  });

  it("reviews the watched chat's last turn again from its start without spending a check", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      await expect(f.command("watcher.review", { linkId: link.id })).rejects.toThrow("no turn to review");
      const watchedTurn = await f.startWatchedTurn();
      await wakeOnce(f, link.id);
      await f.finishTurn(watcherId, "SILENT");
      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
      await f.finishTurn(watcherId, "SILENT");
      const before = f.store.watcherLinks.get(link.id)!;

      await f.command("watcher.review", { linkId: link.id });
      await f.advance(1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no review"); });
      const review = f.provider.input(watcherId);
      expect(review.prompt).toContain("# Check 3 for \"Fix the parser\"");
      expect(review.prompt).toContain("## Brief — quoted evidence\n> Fix the parser bug.");
      expect(review.prompt).toContain("Read src/parser.ts");
      expect(f.store.watcherLinks.wakeForTurn(review.turnId)).toMatchObject({ trigger: "initial", watchedTurnId: watchedTurn.id });
      await expect(f.command("watcher.review", { linkId: link.id })).rejects.toThrow("already checking");
      await f.finishTurn(watcherId, "SILENT");
      const after = f.store.watcherLinks.get(link.id)!;
      expect(after.counters.wakesThisTurn).toBe(before.counters.wakesThisTurn);
      expect(after.counters.wakeAllowance).toBe(before.counters.wakeAllowance);
      expect(after.cursor.activityAt).not.toBeNull();

      await f.command("watcher.pause", { linkId: link.id });
      await expect(f.command("watcher.review", { linkId: link.id })).rejects.toThrow("Resume the watcher");
      await f.command("watcher.detach", { linkId: link.id });
      await expect(f.command("watcher.review", { linkId: link.id })).rejects.toThrow("no longer attached");
    } finally {
      await f.close();
    }
  });
});
