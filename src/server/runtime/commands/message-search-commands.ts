import type WebSocket from "ws";
import type { ServerEvent } from "../../../shared/contracts";
import type { MessageSearchResult, MessageSearchTarget } from "../../../shared/message-search";
import type { RuntimeStore } from "../../database";
import { runMessageSearchWorker } from "../../persistence/message-search-worker-client";
import { RuntimeRequestError } from "../../runtime-errors";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

interface SearchJob {
  requestId: string;
  controller: AbortController;
  result: Promise<MessageSearchResult>;
}

/** One latest request per socket, with a runtime-wide worker ceiling. */
export class MessageSearchController {
  private readonly jobs = new Map<WebSocket, SearchJob>();
  private running = 0;
  private closed = false;

  constructor(
    private readonly databasePath: string,
    private readonly worker = runMessageSearchWorker,
  ) {}

  search(socket: WebSocket, requestId: string, query: string): Promise<MessageSearchResult> {
    const previous = this.jobs.get(socket);
    previous?.controller.abort();
    const controller = new AbortController();
    const disconnected = (): void => controller.abort();
    socket.once("close", disconnected);
    const result = Promise.resolve().then(async () => {
      await previous?.result.catch(() => undefined);
      if (this.closed || controller.signal.aborted) throw new RuntimeRequestError("Search cancelled.");
      if (this.running >= 2) throw new RuntimeRequestError("Message search is busy. Try again shortly.");
      this.running += 1;
      try {
        return await this.worker(this.databasePath, query, controller.signal);
      } catch {
        throw new RuntimeRequestError(controller.signal.aborted
          ? "Search cancelled."
          : "Message search could not finish. Try again with a more specific phrase.");
      } finally {
        this.running -= 1;
      }
    }).finally(() => {
      socket.off("close", disconnected);
      if (this.jobs.get(socket)?.controller === controller) this.jobs.delete(socket);
    });
    this.jobs.set(socket, { requestId, controller, result });
    return result;
  }

  cancel(socket: WebSocket, requestId?: string): void {
    const job = this.jobs.get(socket);
    if (job && (requestId === undefined || job.requestId === requestId)) job.controller.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.result));
  }
}

export function createMessageSearchCommandHandler(input: {
  searches: MessageSearchController;
  store: Pick<RuntimeStore, "messageSearchTarget">;
  send(socket: WebSocket, event: ServerEvent): void;
  reveal(target: MessageSearchTarget): void;
}): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "conversation.messages.search", "conversation.messages.search.cancel", "conversation.message.reveal",
  ], async (socket, command) => {
    switch (command.type) {
      case "conversation.messages.search": {
        const result = await input.searches.search(socket, command.requestId, command.payload.query);
        input.send(socket, { type: "request.result", requestId: command.requestId, result });
        return "handled";
      }
      case "conversation.messages.search.cancel":
        input.searches.cancel(socket, command.payload.searchRequestId);
        input.send(socket, { type: "request.ok", requestId: command.requestId });
        return "handled";
      case "conversation.message.reveal": {
        const target = command.payload;
        const current = input.store.messageSearchTarget(target.messageId);
        if (!current || current.projectId !== target.projectId
          || current.conversationId !== target.conversationId || current.turnId !== target.turnId) {
          throw new RuntimeRequestError("This search result is no longer available.");
        }
        input.reveal(target);
        input.send(socket, { type: "request.ok", requestId: command.requestId });
        return "handled";
      }
      default: return "not-handled";
    }
  });
}
