import { randomUUID } from "node:crypto";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import { watcherMutationEvent } from "../../src/shared/contracts/watcher-schema";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
} from "../../src/server/runtime/commands/command-router";
import { createWatcherCommandHandler, WATCHER_COMMAND_TYPES } from "../../src/server/runtime/commands/watcher-commands";
import { WATCHER_SETTLE_DELAY_MS } from "../../src/server/runtime/watcher/watcher-wake-scheduler";
import {
  cleanupWatcherFixtures,
  createWatcherFixture,
  type WatcherFixture,
} from "../support/watcher-runtime-fixture";

afterEach(cleanupWatcherFixtures);

async function finalPassFinding(f: WatcherFixture, watcherId: string, text: string): Promise<void> {
  await f.startWatchedTurn();
  await f.finishTurn(f.watched.id, "Done.");
  await f.advance(WATCHER_SETTLE_DELAY_MS + 60_000);
  await vi.waitFor(() => { if (!f.provider.runs.has(watcherId)) throw new Error("no final pass"); });
  await f.finishTurn(watcherId, text);
}

function result(reply: ServerEvent) {
  if (reply.type !== "request.result") throw new Error(`Expected a result, got ${reply.type}.`);
  return reply.result;
}

describe("watcher commands", () => {
  it("owns exactly the nine watcher commands beside every other owner", async () => {
    const handler = createWatcherCommandHandler({
      coordinator: {} as never,
      delivery: {} as never,
      send: () => undefined,
    });
    const watcherTypes = RUNTIME_COMMAND_TYPES.filter((type) => type.startsWith("watcher."));
    expect([...handler.commandTypes!].sort()).toEqual([...watcherTypes].sort());
    expect(WATCHER_COMMAND_TYPES).toHaveLength(9);
    expect(() => createRuntimeCommandExecutor({
      handlers: [
        handler,
        defineRuntimeCommandHandler(RUNTIME_COMMAND_TYPES.filter((type) => !type.startsWith("watcher.")), async () => "handled"),
      ],
      send: () => undefined,
      broadcastSnapshot: () => undefined,
      publicError: () => "hidden",
    })).not.toThrow();
  });

  it("validates payloads at the handler boundary", async () => {
    const f = await createWatcherFixture();
    try {
      await expect(f.command("watcher.attach", { linkId: "not-a-uuid" })).rejects.toThrow("The watcher request was invalid.");
      await expect(f.command("watcher.update", { linkId: randomUUID() })).rejects.toThrow("The watcher request was invalid.");
      await expect(f.command("watcher.note.deliver", { linkId: randomUUID(), wakeId: randomUUID(), mode: "shout", deliveryId: randomUUID() }))
        .rejects.toThrow("The watcher request was invalid.");
      await expect(f.command("watcher.feed.get", { linkId: randomUUID(), beforeSequence: 0 })).rejects.toThrow("The watcher request was invalid.");
      await expect(f.command("watcher.pause", { linkId: randomUUID() })).rejects.toThrow("no longer attached");
      expect(await f.watchers.handler(null as unknown as WebSocket, {
        type: "project.select", requestId: randomUUID(), payload: { projectId: randomUUID() },
      } as ClientCommand)).toBe("not-handled");
    } finally {
      await f.close();
    }
  });

  it("returns contract-valid watcher.link, watcher.feed and watcher.delivery results and events", async () => {
    const f = await createWatcherFixture();
    try {
      const attached = result(await f.command("watcher.attach", {
        linkId: randomUUID(), watchedConversationId: f.watched.id,
        modelSelection: f.store.conversation(f.watched.id).modelSelection,
        preset: "explainer", instructions: "Keep it short.",
        sharing: { brief: true, activities: true, changedFiles: false, partialReplies: false },
        budgets: { wakesPerWatchedTurn: 6, cooldownSeconds: 30, digestKiB: 16, contextReadsPerWake: 2 },
        privateConnect: "hidden", initialReview: false,
      }));
      expect(attached).toMatchObject({ kind: "watcher.link", link: { preset: "explainer", privateConnect: "hidden", status: "watching" } });
      if (attached.kind !== "watcher.link") throw new Error("unexpected");
      const linkId = attached.link.id;
      const watcherId = attached.link.watcherConversationId;

      expect(result(await f.command("watcher.update", { linkId, privateConnect: "inherit", instructions: "Shorter." })))
        .toMatchObject({ kind: "watcher.link", link: { privateConnect: "inherit", instructions: "Shorter." } });
      expect(result(await f.command("watcher.pause", { linkId }))).toMatchObject({ link: { status: "paused" } });
      expect(result(await f.command("watcher.resume", { linkId }))).toMatchObject({ link: { status: "watching" } });

      await finalPassFinding(f, watcherId, "First finding.");
      const firstFeed = result(await f.command("watcher.feed.get", { linkId }));
      expect(firstFeed).toMatchObject({ kind: "watcher.feed", linkId, next: null, items: [{ outcome: "finding", finding: "First finding." }] });
      if (firstFeed.kind !== "watcher.feed") throw new Error("unexpected");
      expect(result(await f.command("watcher.note.dismiss", { linkId, wakeId: firstFeed.items[0]!.wakeId })))
        .toMatchObject({ kind: "watcher.delivery", delivery: { state: "dismissed" } });

      await finalPassFinding(f, watcherId, "Second finding.");
      const secondFeed = result(await f.command("watcher.feed.get", { linkId }));
      if (secondFeed.kind !== "watcher.feed") throw new Error("unexpected");
      const paged = result(await f.command("watcher.feed.get", { linkId, beforeSequence: secondFeed.items[0]!.sequence }));
      expect(paged).toMatchObject({ kind: "watcher.feed", items: [{ finding: "First finding." }] });
      expect(result(await f.command("watcher.note.deliver", {
        linkId, wakeId: secondFeed.items[0]!.wakeId, mode: "queue", deliveryId: randomUUID(),
      }))).toMatchObject({ kind: "watcher.delivery", delivery: { mode: "queue", state: "sent" } });
      await vi.waitFor(() => { if (!f.provider.runs.has(f.watched.id)) throw new Error("note turn not started"); });
      await f.finishTurn(f.watched.id, "Handled the note.");

      expect(result(await f.command("watcher.wake", { linkId }))).toMatchObject({ kind: "watcher.link" });
      expect(result(await f.command("watcher.detach", { linkId }))).toMatchObject({ link: { status: "detached" } });

      for (const reply of f.sent.filter((event) => event.type === "request.result")) {
        expect(() => serverEventSchema.parse(reply)).not.toThrow();
      }
      const watcherEvents = f.watcherEvents();
      expect(new Set(watcherEvents.map(({ type }) => type))).toEqual(new Set(["watcher.link.updated", "watcher.link.removed", "watcher.live"]));
      for (const event of watcherEvents) expect(watcherMutationEvent(event)).toBe(true);
    } finally {
      await f.close();
    }
  });
});
