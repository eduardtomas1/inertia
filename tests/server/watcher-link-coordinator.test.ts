import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import type { WatcherAttachPayload } from "../../src/shared/contracts/client-command/watcher";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING, MAX_ACTIVE_WATCHERS } from "../../src/shared/watcher";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import {
  createProjectWorkspaceCommandHandler,
  type ProjectWorkspaceCommandDependencies,
} from "../../src/server/runtime/commands/project-workspace-commands";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { WATCHER_PENDING_PUBLISH_MS } from "../../src/server/runtime/watcher/watcher-runtime";
import { WATCHER_SETTLE_DELAY_MS } from "../../src/server/runtime/watcher/watcher-wake-scheduler";
import {
  cleanupWatcherFixtures,
  createWatcherFixture,
  WATCHER_TEST_PROVIDERS,
  watcherTestSelection,
  type WatcherFixture,
} from "../support/watcher-runtime-fixture";

afterEach(cleanupWatcherFixtures);

const now = () => new Date().toISOString();
let sequence = 0;

async function refused(f: WatcherFixture, overrides: Record<string, unknown>, message: string): Promise<void> {
  await expect(f.attach(overrides)).rejects.toThrow(message);
}

async function wake(f: WatcherFixture, watcherId: string): Promise<void> {
  f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label: "Read a.ts", activityId: `a-${++sequence}` });
  await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
  await vi.waitFor(() => {
    if (!f.provider.runs.has(watcherId)) throw new Error("watcher not running");
  });
}

function notReady(id: ProviderInfo["id"]): () => ProviderInfo[] {
  return () => WATCHER_TEST_PROVIDERS.map((provider) =>
    provider.id === id ? { ...provider, canRun: false, statusMessage: "Sign in to continue." } : provider);
}

describe("watcher link coordinator", () => {
  it("creates a locked, read-only watcher chat in the watched chat's checkout", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ preset: "scope-guard", modelSelection: watcherTestSelection("claude") });
      const watcher = f.store.conversation(link.watcherConversationId);
      expect(watcher).toMatchObject({
        projectId: f.project.id,
        providerId: "claude",
        interactionMode: "plan",
        accessMode: "supervised",
        branch: f.watched.branch,
        worktreePath: f.watched.worktreePath,
        title: "Watcher · Scope guard · Fix the parser",
      });
      expect(f.store.conversationTitleLocked(watcher.id)).toBe(true);
      expect(f.store.shellSnapshot().activeConversationId).not.toBe(watcher.id);
      expect(f.watcherEvents()).toContainEqual({ type: "watcher.link.updated", link: expect.objectContaining({ id: link.id }) });
      await expect(f.attach({ linkId: link.id })).resolves.toMatchObject({ id: link.id });
    } finally {
      await f.close();
    }
  });

  it("refuses scratch projects, archived chats, watchers, duplicates and unready or disallowed routes", async () => {
    const f = await createWatcherFixture();
    try {
      await refused(f, { modelSelection: watcherTestSelection("cursor") }, "This agent can't run as a watcher.");
      f.setProviderInfo(notReady("codex"));
      await refused(f, {}, "Sign in to continue.");
      f.setProviderInfo(() => WATCHER_TEST_PROVIDERS);

      const link = await f.attach();
      await refused(f, {}, "already has a watcher");
      await refused(f, { watchedConversationId: link.watcherConversationId }, "can't watch another watcher");

      const archived = f.store.createConversation(f.project.id, "Old work");
      f.store.archiveConversation(archived.id, true);
      await refused(f, { watchedConversationId: archived.id }, "Unarchive this chat");

      const scratchRoot = join(f.directory, "scratch");
      await mkdir(scratchRoot);
      const scratch = f.store.createProject("No project", scratchRoot, { workspaceKind: "scratch", activate: false });
      const chat = f.store.createConversation(scratch.id, "Scratch chat");
      await refused(f, { watchedConversationId: chat.id }, "needs a chat in a project");
      expect(f.store.watcherLinks.active()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("checks that a watched worktree is the checkout it records", async () => {
    const f = await createWatcherFixture();
    try {
      const worktree = join(f.directory, "worktree");
      await mkdir(worktree);
      const chat = f.store.createConversation(f.project.id, "Worktree chat", {
        modelSelection: watcherTestSelection("codex"), worktreePath: worktree, branch: "feature",
      });
      const path = vi.spyOn(f.store, "conversationPath").mockReturnValueOnce(join(f.directory, "elsewhere"));
      await refused(f, { watchedConversationId: chat.id }, "not the checkout it records");
      path.mockRestore();
      const link = await f.attach({ watchedConversationId: chat.id });
      expect(f.store.conversation(link.watcherConversationId)).toMatchObject({ worktreePath: worktree, branch: "feature" });
      f.store.deleteConversation(link.watcherConversationId);
      expect(f.store.conversation(chat.id).worktreePath).toBe(worktree);
    } finally {
      await f.close();
    }
  });

  it("detach cancels the running check and returns the watcher chat to an ordinary chat", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      await wake(f, link.watcherConversationId);
      const turnId = f.provider.input(link.watcherConversationId).turnId;
      const reply = await f.command("watcher.detach", { linkId: link.id });
      expect(reply).toMatchObject({ type: "request.result", result: { kind: "watcher.link", link: { status: "detached", detachedReason: "user" } } });
      await f.flush();
      expect(f.store.agentTurn(turnId).status).toBe("cancelled");
      expect(f.store.watcherLinks.wakeForTurn(turnId)).toMatchObject({ state: "settled", outcome: "cancelled" });
      expect(f.watcherEvents()).toContainEqual({
        type: "watcher.link.removed", linkId: link.id, watcherConversationId: link.watcherConversationId, watchedConversationId: f.watched.id,
      });
      expect(f.watchers.isWatcherConversation(link.watcherConversationId)).toBe(false);
      expect(f.store.watcherLinks.views()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("broadcasts the removal of a link whose watched chat is deleted and drops its pending checks", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label: "Read a.ts", activityId: `a-${++sequence}` });
      await f.finishTurn(f.watched.id, "Done");
      expect(f.provider.runs.has(link.watcherConversationId)).toBe(false);
      const before = f.watcherEvents().length;
      const handler = createConversationCommandHandler({
        store: f.store,
        providerTerminalResumes: { acquireAtCheckout: () => true, release: () => undefined },
        runtimeSync: { broadcast: () => undefined },
        conversationAttachments: { release: async () => undefined },
        rememberDeletedConversation: () => undefined,
        forgetRemoteTranscript: () => undefined,
        watchers: f.watchers,
      } as unknown as ConversationCommandDependencies);
      await handler({} as never, { type: "conversation.delete", requestId: randomUUID(), payload: { conversationId: f.watched.id } });
      expect(f.linkView(link.id)).toMatchObject({ status: "detached", detachedReason: "watched-deleted", watchedConversationId: null });
      expect(f.watcherEvents().slice(before)).toEqual([{
        type: "watcher.link.removed", linkId: link.id, watcherConversationId: link.watcherConversationId, watchedConversationId: f.watched.id,
      }]);
      await f.advance(WATCHER_SETTLE_DELAY_MS + 120_000);
      expect(f.provider.inputs.filter(({ conversationId }) => conversationId === link.watcherConversationId)).toEqual([]);
      expect(f.store.watcherLinks.views()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("forgets and broadcasts the removal of a link whose project is removed", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label: "Read a.ts", activityId: `a-${++sequence}` });
      await f.finishTurn(f.watched.id, "Done");
      expect(f.provider.runs.has(link.watcherConversationId)).toBe(false);
      const before = f.watcherEvents().length;
      const handler = createProjectWorkspaceCommandHandler({
        store: f.store,
        turns: f.controller,
        providerTerminalResumes: { isActive: () => false },
        conversationAttachments: { release: async () => undefined },
        rememberDeletedConversation: () => undefined,
        forgetRemoteTranscript: () => undefined,
        watchers: f.watchers,
      } as unknown as ProjectWorkspaceCommandDependencies);
      await handler({} as never, { type: "project.remove", requestId: randomUUID(), payload: { projectId: f.project.id } });
      expect(f.store.watcherLinks.get(link.id)).toBeNull();
      expect(f.watcherEvents().slice(before)).toEqual([{
        type: "watcher.link.removed", linkId: link.id, watcherConversationId: link.watcherConversationId, watchedConversationId: f.watched.id,
      }]);
      await f.advance(WATCHER_SETTLE_DELAY_MS + 120_000);
      expect(f.provider.inputs.filter(({ conversationId }) => conversationId === link.watcherConversationId)).toEqual([]);
      expect(f.watchers.isWatcherConversation(link.watcherConversationId)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("broadcasts the removal of a link whose watcher chat is deleted", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const unrelated = f.watchers.beforeConversationDelete(randomUUID());
      const publish = f.watchers.beforeConversationDelete(link.watcherConversationId);
      f.store.deleteConversation(link.watcherConversationId);
      const before = f.watcherEvents().length;
      unrelated();
      expect(f.watcherEvents()).toHaveLength(before);
      publish();
      expect(f.store.watcherLinks.get(link.id)).toBeNull();
      expect(f.watcherEvents().slice(before)).toEqual([{
        type: "watcher.link.removed", linkId: link.id, watcherConversationId: link.watcherConversationId, watchedConversationId: f.watched.id,
      }]);
    } finally {
      await f.close();
    }
  });

  it("pauses and resumes, gating usage-limit resumes on a ready route and re-granting checks", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await expect(f.command("watcher.pause", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { status: "paused", pauseReason: "user" } } });
      await expect(f.command("watcher.wake", { linkId: link.id })).rejects.toThrow("Resume the watcher");
      await expect(f.command("watcher.resume", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { status: "watching", pauseReason: null } } });

      f.store.watcherLinks.transition(link.id, ["watching"], { status: "paused", reason: "usage-limit" }, now());
      f.setProviderInfo(notReady("codex"));
      await expect(f.command("watcher.resume", { linkId: link.id })).rejects.toThrow(/^Sign in to continue\.$/u);
      f.setProviderInfo(() => WATCHER_TEST_PROVIDERS);
      await expect(f.command("watcher.resume", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { status: "watching" } } });

      f.store.watcherLinks.transition(link.id, ["watching"], { status: "paused", reason: "write-detected", detail: "src/a.ts" }, now());
      await expect(f.command("watcher.resume", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { status: "watching" } } });

      f.store.watcherLinks.beginWatchedTurn(link.id, "turn-x", now());
      f.store.watcherLinks.transition(link.id, ["watching"], { status: "paused", reason: "wake-budget" }, now());
      const exhausted = f.store.watcherLinks.get(link.id)!;
      const reply = await f.command("watcher.resume", { linkId: link.id });
      expect(reply).toMatchObject({ result: { link: { status: "watching" } } });
      const resumed = f.store.watcherLinks.get(link.id)!;
      expect(resumed.counters.wakeAllowance - resumed.counters.wakesThisTurn)
        .toBe(exhausted.budgets.wakesPerWatchedTurn);
    } finally {
      await f.close();
    }
  });

  it("keeps following the watched chat after it switches provider", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      await f.finishTurn(f.watched.id, "Done.");
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(link.watcherConversationId)) throw new Error("no final pass"); });
      await f.finishTurn(link.watcherConversationId, "SILENT");

      f.store.updateConversation(f.watched.id, { providerId: "claude", modelSelection: watcherTestSelection("claude") });
      const turn = await f.startWatchedTurn("Now on another agent.");
      expect(f.store.agentTurn(turn.id).harnessId).toBe("claude-agent-sdk");
      await wake(f, link.watcherConversationId);
      expect(f.provider.input(link.watcherConversationId).prompt).toContain("Now on another agent.");
      expect(f.store.watcherLinks.get(link.id)!.watchedTurnId).toBe(turn.id);
    } finally {
      await f.close();
    }
  });

  it("runs exactly one final pass after a restart for a watched turn that ended meanwhile", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      f.watchers.dispose();
      await f.finishTurn(f.watched.id, "Finished while Inertia was closed.");
      expect(f.provider.runs.has(link.watcherConversationId)).toBe(false);

      f.restartRuntime().resume();
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(link.watcherConversationId)) throw new Error("no final pass"); });
      const final = f.provider.input(link.watcherConversationId);
      expect(f.store.watcherLinks.wakeForTurn(final.turnId)).toMatchObject({ trigger: "turn-end" });
      expect(final.prompt).toContain("Final check for this turn");
      await f.finishTurn(link.watcherConversationId, "SILENT");

      f.watchers.resume();
      f.restartRuntime().resume();
      await f.advance(10 * 60_000);
      expect(f.provider.inputs.filter((input) => input.conversationId === link.watcherConversationId)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("runs after a restart the final pass of a turn that ended just before the next one began", async () => {
    const f = await createWatcherFixture();
    try {
      await f.startWatchedTurn("Before the watcher");
      await f.finishTurn(f.watched.id, "Done before the watcher.");
      const link = await f.attach();
      const watcherId = link.watcherConversationId;
      const first = await f.startWatchedTurn("First task");
      await f.finishTurn(f.watched.id, "First done.");
      const second = await f.startWatchedTurn("Second task");
      f.watchers.dispose();
      expect(f.provider.runs.has(watcherId)).toBe(false);

      f.restartRuntime().resume();
      await f.advance(WATCHER_SETTLE_DELAY_MS + 1);
      await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
      expect(f.store.watcherLinks.wakeForTurn(f.provider.input(watcherId).turnId)).toMatchObject({ trigger: "turn-end", watchedTurnId: first.id });
      await f.finishTurn(watcherId, "SILENT");
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ finalPassTurnId: first.id, watchedTurnId: second.id });

      f.watchers.dispose();
      f.restartRuntime().resume();
      await f.advance(10 * 60_000);
      expect(f.provider.inputs.filter((input) => input.conversationId === watcherId)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("reviews the last completed turn right away when asked, and only then", async () => {
    const f = await createWatcherFixture();
    try {
      const quiet = await f.attach({ initialReview: true });
      await f.advance(1);
      expect(f.provider.runs.has(quiet.watcherConversationId)).toBe(false);
      await f.command("watcher.detach", { linkId: quiet.id });

      await f.startWatchedTurn();
      await f.finishTurn(f.watched.id, "All done.");
      const link = await f.attach({ initialReview: true });
      await f.advance(1);
      await vi.waitFor(() => { if (!f.provider.runs.has(link.watcherConversationId)) throw new Error("no initial review"); });
      const input = f.provider.input(link.watcherConversationId);
      expect(f.store.watcherLinks.wakeForTurn(input.turnId)).toMatchObject({ trigger: "initial" });
      expect(input.prompt).toContain("Fix the parser bug.");
      await f.finishTurn(link.watcherConversationId, "SILENT");
      expect(f.store.watcherLinks.get(link.id)!.counters).toMatchObject({ wakesTotal: 1, wakesThisTurn: 0 });
    } finally {
      await f.close();
    }
  });

  it("marks the main chat quiet after ten minutes without output and clears it on the next output", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      await f.advance(11 * 60_000);
      expect(f.store.watcherLinks.get(link.id)!.quietSince).not.toBeNull();
      expect(f.watcherEvents().filter((event) => event.type === "watcher.link.updated").at(-1))
        .toMatchObject({ link: { quietSince: expect.any(String) } });
      f.provider.emit(f.watched.id, { type: "text", text: "Still working." });
      f.turnTimers.advance(1_000);
      expect(f.store.watcherLinks.get(link.id)!.quietSince).toBeNull();
      expect(f.watcherEvents().filter((event) => event.type === "watcher.link.updated").at(-1))
        .toMatchObject({ link: { quietSince: null } });
    } finally {
      await f.close();
    }
  });

  it("refuses to delete a watched chat mid-check before touching its checkout, ownership or checkpoints", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      await wake(f, link.watcherConversationId);
      await f.finishTurn(f.watched.id, "Done.");
      const acquireAtCheckout = vi.fn(() => true);
      const ownership = vi.spyOn(f.store.conversationWorktrees, "get");
      const transfer = vi.spyOn(f.store.conversationWorktrees, "transfer");
      const handler = createConversationCommandHandler({
        store: f.store,
        providerTerminalResumes: { acquireAtCheckout, release: () => undefined },
        runtimeSync: { broadcast: () => undefined },
        conversationAttachments: { release: async () => undefined },
        rememberDeletedConversation: () => undefined,
        forgetRemoteTranscript: () => undefined,
        watchers: f.watchers,
      } as unknown as ConversationCommandDependencies);
      const attempt = handler({} as never, { type: "conversation.delete", requestId: randomUUID(), payload: { conversationId: f.watched.id } });
      await expect(attempt).rejects.toBeInstanceOf(RuntimeRequestError);
      await expect(attempt).rejects.toThrow("The watcher is still working. Wait for it to finish or choose Stop watching…, then delete this chat.");
      expect(acquireAtCheckout).not.toHaveBeenCalled();
      expect(ownership).not.toHaveBeenCalled();
      expect(transfer).not.toHaveBeenCalled();
      expect(f.store.conversationShell(f.watched.id)).not.toBeNull();
      expect(f.linkView(link.id).status).not.toBe("detached");

      await f.finishTurn(link.watcherConversationId, "SILENT");
      await handler({} as never, { type: "conversation.delete", requestId: randomUUID(), payload: { conversationId: f.watched.id } });
      expect(f.linkView(link.id)).toMatchObject({ status: "detached", detachedReason: "watched-deleted" });
    } finally {
      await f.close();
    }
  });

  it("pauses a watcher whose own chat is archived until that chat is unarchived", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const handler = createConversationCommandHandler({
        store: f.store,
        providerTerminalResumes: { isActive: () => false },
        forgetRemoteTranscript: () => undefined,
        watchers: f.watchers,
      } as unknown as ConversationCommandDependencies);
      await handler({} as never, { type: "conversation.archive", requestId: randomUUID(), payload: { conversationId: link.watcherConversationId } });
      expect(f.linkView(link.id)).toMatchObject({ status: "paused", pauseReason: "watcher-archived", pauseDetail: "The watcher chat was archived. Unarchive it to resume the watcher." });
      await f.startWatchedTurn();
      await f.advance(10 * 60_000);
      expect(f.provider.inputs.filter(({ conversationId }) => conversationId === link.watcherConversationId)).toEqual([]);
      await expect(f.command("watcher.resume", { linkId: link.id })).rejects.toThrow("Unarchive the watcher chat");
      f.store.archiveConversation(link.watcherConversationId, false);
      await expect(f.command("watcher.resume", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { status: "watching" } } });
    } finally {
      await f.close();
    }
  });

  it("answers concurrent attaches with one link id and over the limit with policy errors, never a raw SQLite error", async () => {
    const f = await createWatcherFixture();
    try {
      const payload: WatcherAttachPayload = {
        linkId: randomUUID(), watchedConversationId: f.watched.id,
        modelSelection: watcherTestSelection("codex") as WatcherAttachPayload["modelSelection"],
        preset: "reviewer", instructions: "", sharing: { ...DEFAULT_WATCHER_SHARING }, budgets: { ...DEFAULT_WATCHER_BUDGETS },
        privateConnect: "inherit", initialReview: false,
      };
      const [first, second] = await Promise.all([f.watchers.coordinator.attach(payload), f.watchers.coordinator.attach(payload)]);
      expect(second.id).toBe(first.id);
      expect(f.store.watcherLinks.active()).toHaveLength(1);

      for (let index = 1; index < MAX_ACTIVE_WATCHERS - 1; index += 1) {
        const watched = f.store.createConversation(f.project.id, `Chat ${index}`, { modelSelection: watcherTestSelection("codex") });
        await f.watchers.coordinator.attach({ ...payload, linkId: randomUUID(), watchedConversationId: watched.id });
      }
      const racers = [0, 1].map((index) =>
        f.store.createConversation(f.project.id, `Racer ${index}`, { modelSelection: watcherTestSelection("codex") }));
      const results = await Promise.allSettled(racers.map((watched) =>
        f.watchers.coordinator.attach({ ...payload, linkId: randomUUID(), watchedConversationId: watched.id })));
      expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")!;
      expect(rejected.reason).toBeInstanceOf(RuntimeRequestError);
      expect(rejected.reason.message).toBe("Inertia already has eight active watchers. Stop one first.");
      expect(f.store.watcherLinks.active()).toHaveLength(MAX_ACTIVE_WATCHERS);
    } finally {
      await f.close();
    }
  });

  it("cancels a running check when the watcher's own chat is archived", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      await wake(f, link.watcherConversationId);
      expect(f.linkView(link.id).status).toBe("waking");
      f.store.archiveConversation(link.watcherConversationId, true);
      f.watchers.onConversationArchived(link.watcherConversationId);
      expect(f.provider.cancelled).toContain(link.watcherConversationId);
      await f.flush();
      expect(f.linkView(link.id)).toMatchObject({ status: "paused", pauseReason: "watcher-archived" });
      expect(f.store.watcherLinks.feed(link.id)?.items[0]).toMatchObject({ state: "settled", outcome: "cancelled" });
    } finally {
      await f.close();
    }
  });

  it("cancels a running check when the watched chat is archived", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      await wake(f, link.watcherConversationId);
      expect(f.linkView(link.id).status).toBe("waking");
      f.store.archiveConversation(f.watched.id, true);
      f.watchers.onConversationArchived(f.watched.id);
      expect(f.provider.cancelled).toContain(link.watcherConversationId);
      await f.flush();
      expect(f.linkView(link.id)).toMatchObject({ status: "paused", pauseReason: "watched-archived" });
      expect(f.store.watcherLinks.feed(link.id)?.items[0]).toMatchObject({ state: "settled", outcome: "cancelled" });
    } finally {
      await f.close();
    }
  });

  it("records the archive of a watched chat over an earlier pause and refuses to resume until it is unarchived", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.command("watcher.pause", { linkId: link.id });
      f.store.archiveConversation(f.watched.id, true);
      f.watchers.onConversationArchived(f.watched.id);
      expect(f.linkView(link.id)).toMatchObject({ status: "paused", pauseReason: "watched-archived" });
      await expect(f.command("watcher.resume", { linkId: link.id })).rejects.toThrow("Unarchive the watched chat");
      f.store.archiveConversation(f.watched.id, false);
      await expect(f.command("watcher.resume", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { status: "watching" } } });
    } finally {
      await f.close();
    }
  });

  it("refuses to resume while the watched chat is archived, whatever the pause reason", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.command("watcher.pause", { linkId: link.id });
      f.store.archiveConversation(f.watched.id, true);
      await expect(f.command("watcher.resume", { linkId: link.id })).rejects.toThrow("Unarchive the watched chat");
    } finally {
      await f.close();
    }
  });

  it("pauses when a shell update reports an archive that bypassed the archive command", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      f.store.archiveConversation(f.watched.id, true);
      f.watchers.observe({ type: "conversation.shell.updated", conversation: f.store.conversationShell(f.watched.id)!, runs: [] } as never);
      expect(f.linkView(link.id)).toMatchObject({ status: "paused", pauseReason: "watched-archived" });
    } finally {
      await f.close();
    }
  });

  it("clears a stored waiting count on restart, since the new scheduler starts with none", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label: "Read a.ts", activityId: `a-${++sequence}` });
      await f.advance(WATCHER_PENDING_PUBLISH_MS);
      expect(f.linkView(link.id).counters.eventsPending).toBeGreaterThan(0);
      f.restartRuntime().resume();
      expect(f.linkView(link.id).counters.eventsPending).toBe(0);
      expect(f.watcherEvents().at(-1)).toMatchObject({
        type: "watcher.link.updated",
        link: { id: link.id, counters: expect.objectContaining({ eventsPending: 0 }) },
      });
    } finally {
      await f.close();
    }
  });

  it("never makes a later final check of the turn an initial review already covered", async () => {
    const f = await createWatcherFixture();
    try {
      await f.startWatchedTurn();
      await f.finishTurn(f.watched.id, "All done.");
      const link = await f.attach({ initialReview: true });
      await f.advance(1);
      await vi.waitFor(() => { if (!f.provider.runs.has(link.watcherConversationId)) throw new Error("no initial review"); });
      await f.finishTurn(link.watcherConversationId, "SILENT");
      expect(f.linkView(link.id).finalPassTurnId).toBe(f.linkView(link.id).watchedTurnId);

      f.restartRuntime().resume();
      await f.advance(10 * 60_000);
      expect(f.provider.inputs.filter(({ conversationId }) => conversationId === link.watcherConversationId)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("returns instructions and usage in command results but leaves them out of the shell broadcast", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ instructions: "Watch the error paths." });
      expect(link.instructions).toBe("Watch the error paths.");
      const updated = f.watcherEvents().filter((event) => event.type === "watcher.link.updated").at(-1);
      expect(updated).toMatchObject({ link: { id: link.id } });
      expect((updated as { link: object }).link).not.toHaveProperty("instructions");
      expect((updated as { link: object }).link).not.toHaveProperty("usage");
      expect(link.usage).toEqual({ totalTokens: null });
      expect(f.store.watcherLinks.views()[0]).not.toHaveProperty("instructions");
      await expect(f.command("watcher.pause", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { instructions: "Watch the error paths.", usage: { totalTokens: null } } } });
      const feed = await f.command("watcher.feed.get", { linkId: link.id });
      expect(feed).toMatchObject({ result: { kind: "watcher.feed", linkId: link.id, usage: { totalTokens: null } } });
      expect(() => serverEventSchema.parse(feed)).not.toThrow();
      for (const event of f.watcherEvents()) {
        if (event.type === "watcher.link.updated") expect(event.link).not.toHaveProperty("usage");
      }
    } finally {
      await f.close();
    }
  });

  it("stores the delivery policy on attach, changes it on update and broadcasts both", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ delivery: "auto" });
      expect(link.delivery).toBe("auto");
      expect(f.store.watcherLinks.get(link.id)?.delivery).toBe("auto");
      const broadcast = () => f.watcherEvents().filter((event) => event.type === "watcher.link.updated").at(-1);
      expect(broadcast()).toMatchObject({ link: { id: link.id, delivery: "auto" } });
      await expect(f.command("watcher.update", { linkId: link.id, delivery: "manual" }))
        .resolves.toMatchObject({ result: { link: { delivery: "manual" } } });
      expect(broadcast()).toMatchObject({ link: { id: link.id, delivery: "manual" } });
      f.store.watcherLinks.transition(link.id, ["watching"], { status: "detached", reason: "user" }, now());
      await expect(f.command("watcher.update", { linkId: link.id, delivery: "auto" })).rejects.toThrow("no longer attached");
    } finally {
      await f.close();
    }
  });

  it("pauses when the watched chat is archived", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      const handler = createConversationCommandHandler({
        store: f.store,
        providerTerminalResumes: { isActive: () => false },
        forgetRemoteTranscript: () => undefined,
        watchers: f.watchers,
      } as unknown as ConversationCommandDependencies);
      await handler({} as never, { type: "conversation.archive", requestId: randomUUID(), payload: { conversationId: f.watched.id } });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "watched-archived" });
      await expect(f.command("watcher.resume", { linkId: link.id })).rejects.toThrow("Unarchive the watched chat");
      f.store.archiveConversation(f.watched.id, false);
      await expect(f.command("watcher.resume", { linkId: link.id }))
        .resolves.toMatchObject({ result: { link: { status: "watching" } } });
    } finally {
      await f.close();
    }
  });
});
