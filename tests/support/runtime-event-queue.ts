import WebSocket from "ws";

import type { ServerEvent } from "../../src/shared/contracts";

export class RuntimeEventQueue {
  private readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      // Domain tests consume unwrapped runtime events. Transport sequencing
      // tests use raw sockets and keep the envelope intact.
      this.events.push(event.type === "runtime.event" ? event.event : event);
      for (const listener of this.listeners) listener();
    });
  }

  async next<T extends ServerEvent>(
    predicate: (event: ServerEvent) => event is T,
    description = "a server event",
  ): Promise<T> {
    return await this.waitFor(predicate, 6_000, description);
  }

  async nextForRequest<T extends Extract<
    ServerEvent,
    { type: "request.ok" | "request.result" }
  >>(
    requestId: string,
    predicate: (event: ServerEvent) => event is T,
    deadlineAt: number,
  ): Promise<T> {
    const terminal = await this.waitFor(
      (event): event is Extract<
        ServerEvent,
        { type: "request.error" | "request.ok" | "request.result" }
      > => (
        (
          event.type === "request.error"
          || event.type === "request.ok"
          || event.type === "request.result"
        )
        && event.requestId === requestId
      ),
      Math.max(1, deadlineAt - Date.now()),
      `request ${requestId}`,
    );
    if (terminal.type === "request.error") {
      throw new Error(
        `Server rejected request ${requestId}: ${terminal.message}`,
      );
    }
    if (!predicate(terminal)) {
      throw new Error(
        `Server returned an unexpected response for request ${requestId}: ${terminal.type}.`,
      );
    }
    return terminal;
  }

  private async waitFor<T extends ServerEvent>(
    predicate: (event: ServerEvent) => event is T,
    timeoutMs: number,
    description: string,
  ): Promise<T> {
    const take = (): T | undefined => {
      const index = this.events.findIndex(predicate);
      if (index < 0) return undefined;
      return this.events.splice(index, 1)[0] as T;
    };
    const existing = take();
    if (existing) return existing;

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        const pending = this.events.slice(-12).map((event) => event.type === "request.error" ? `${event.type}:${event.message}` : event.type).join(", ") || "none";
        const latestSnapshot = [...this.events].reverse().find((event) => event.type === "snapshot.updated");
        const providers = latestSnapshot?.type === "snapshot.updated"
          ? latestSnapshot.snapshot.providers.map(({ id, installState, authState, canRun }) => ({ id, installState, authState, canRun }))
          : [];
        const turns = latestSnapshot?.type === "snapshot.updated"
          ? latestSnapshot.snapshot.conversations.flatMap(({ latestTurn }) =>
            latestTurn ? [{ id: latestTurn.id, runId: latestTurn.runId, status: latestTurn.status }] : [])
          : [];
        const snapshotRuns = latestSnapshot?.type === "snapshot.updated"
          ? latestSnapshot.snapshot.runs.map(({ id, conversationId, kind, label, status }) => ({ id, conversationId, kind, label, status }))
          : [];
        const latestShell = [...this.events].reverse().find(
          (event) => event.type === "conversation.shell.updated",
        );
        const shellRuns = latestShell?.type === "conversation.shell.updated"
          ? latestShell.runs.map(({ id, kind, label, status, finishedAt }) => ({ id, kind, label, status, finishedAt }))
          : [];
        reject(new Error(`Timed out waiting for ${description}. Pending event types: ${pending}. Providers: ${JSON.stringify(providers)}. Turns: ${JSON.stringify(turns)}. Snapshot runs: ${JSON.stringify(snapshotRuns)}. Shell runs: ${JSON.stringify(shellRuns)}.`));
      }, timeoutMs);
      const check = (): void => {
        const event = take();
        if (!event) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(event);
      };
      this.listeners.add(check);
    });
  }
}

export async function connectRuntime(
  url: string,
): Promise<{ socket: WebSocket; events: RuntimeEventQueue }> {
  const socket = new WebSocket(url, { origin: "http://localhost:5173" });
  const events = new RuntimeEventQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, events };
}
