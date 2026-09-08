import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { MessageSearchController, createMessageSearchCommandHandler } from "../../src/server/runtime/commands/message-search-commands";
import type { MessageSearchResult, MessageSearchTarget } from "../../src/shared/message-search";
import type { RuntimeStore } from "../../src/server/database";

const socket = (): WebSocket => new EventEmitter() as WebSocket;
const result = (query: string): MessageSearchResult => ({ kind: "conversation.messages.search", query, hits: [], hasMore: false, incomplete: false });
function pendingWorker() {
  const signals: AbortSignal[] = [];
  const worker = vi.fn((_path: string, _query: string, signal: AbortSignal): Promise<MessageSearchResult> => {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private database path")), { once: true }));
  });
  return { worker, signals };
}

describe("message search runtime ownership", () => {
  it("cancels obsolete requests, protects the replacement from stale cancellation, and drains on shutdown", async () => {
    const { worker, signals } = pendingWorker();
    const searches = new MessageSearchController("private.sqlite", worker);
    const client = socket();
    const first = searches.search(client, "first", "first").catch((error: unknown) => error);
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
    const second = searches.search(client, "second", "second").catch((error: unknown) => error);
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    searches.cancel(client, "first");
    expect(signals[1]?.aborted).toBe(false);
    await searches.close();
    expect(signals[1]?.aborted).toBe(true);
    expect(String(await first)).toContain("Search cancelled.");
    expect(String(await second)).not.toContain("private");
    expect(client.listenerCount("close")).toBe(0);
    await expect(searches.search(client, "third", "third")).rejects.toThrow("Search cancelled.");
  });

  it("bounds concurrent scans across clients and cancels on socket disconnection", async () => {
    const { worker, signals } = pendingWorker();
    const searches = new MessageSearchController("private.sqlite", worker);
    const clients = [socket(), socket(), socket()];
    const pending = clients.slice(0, 2).map((client) => searches.search(client, "same-id", "needle").catch(() => undefined));
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2));
    await expect(searches.search(clients[2]!, "third", "needle")).rejects.toThrow(/busy/u);
    clients[0]!.emit("close");
    expect(signals[0]?.aborted).toBe(true);
    await searches.close();
    await Promise.all(pending);
  });

  it("revalidates all result identities and archive state before routing focus", async () => {
    const target: MessageSearchTarget = { projectId: "project", conversationId: "chat", turnId: "legacy-turn", messageId: "message" };
    let current: MessageSearchTarget | null = target;
    const store: Pick<RuntimeStore, "messageSearchTarget"> = { messageSearchTarget: () => current };
    const reveal = vi.fn();
    const send = vi.fn();
    const searches = new MessageSearchController("unused", async (_path, query) => result(query));
    const handler = createMessageSearchCommandHandler({ searches, store, reveal, send });
    const client = socket();
    for (const payload of [
      { ...target, projectId: "other" }, { ...target, conversationId: "other" }, { ...target, turnId: "other" },
    ]) await expect(handler(client, { type: "conversation.message.reveal", requestId: "request", payload })).rejects.toThrow(/no longer available/u);
    current = null;
    await expect(handler(client, { type: "conversation.message.reveal", requestId: "request", payload: target })).rejects.toThrow(/no longer available/u);
    expect(reveal).not.toHaveBeenCalled();
    current = target;
    expect(await handler(client, { type: "conversation.message.reveal", requestId: "request", payload: target })).toBe("handled");
    expect(reveal).toHaveBeenCalledWith(target);
    expect(send).toHaveBeenCalledWith(client, { type: "request.ok", requestId: "request" });
    await searches.close();
  });
});
