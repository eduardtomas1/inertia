import type { Page } from "@playwright/test";
import type { ServerEvent } from "../../../src/shared/contracts";

const SOCKETS_KEY = "__inertiaE2eCapturedWebSockets";
const SEND_GATE_KEY = "__inertiaE2eMessageSendAcknowledgement";

/** Holds a real reply, leaving persistence and other runtime events untouched. */
export async function holdMessageSendAcknowledgement(
  page: Page,
  conversationId: string,
  timeoutMs: number,
): Promise<{ waitUntilHeld: () => Promise<void>; release: () => Promise<void> }> {
  await page.evaluate(({ socketsKey, gateKey, conversationId, timeoutMs }) => {
    const sockets = Reflect.get(window, socketsKey) as WebSocket[] | undefined;
    const socket = sockets?.find(({ readyState }) => readyState === WebSocket.OPEN);
    if (!socket) throw new Error("The captured runtime socket is unavailable.");
    const send = socket.send;
    let requestId: string | null = null;
    let acknowledgement: string | null = null;
    let released = false;
    let expired = false;
    const release = (timedOut = false): void => {
      if (released) return;
      released = true;
      expired = timedOut;
      clearTimeout(timeout);
      socket.send = send;
      if (acknowledgement !== null) {
        socket.dispatchEvent(new MessageEvent("message", { data: acknowledgement }));
      }
    };
    const receive = (source: WebSocket, message: MessageEvent<string>): void => {
      if (source !== socket || released) return;
      const frame = JSON.parse(message.data) as ServerEvent;
      const event = frame.type === "runtime.event" ? frame.event : frame;
      if (event.type !== "request.ok" && event.type !== "request.result") return;
      if (requestId === null || event.requestId !== requestId) return;
      acknowledgement = message.data;
      message.stopImmediatePropagation();
    };
    socket.send = (data) => {
      if (typeof data === "string") {
        const command = JSON.parse(data) as {
          type: string; requestId: string; payload?: { conversationId?: string };
        };
        if (requestId === null && command.type === "message.send"
          && command.payload?.conversationId === conversationId) requestId = command.requestId;
      }
      send.call(socket, data);
    };
    const timeout = setTimeout(() => release(true), timeoutMs);
    Reflect.set(window, gateKey, {
      held: () => acknowledgement !== null && !released,
      expired: () => expired,
      receive,
      release,
    });
  }, { socketsKey: SOCKETS_KEY, gateKey: SEND_GATE_KEY, conversationId, timeoutMs });
  return {
    waitUntilHeld: async () => {
      const handle = await page.waitForFunction((key) => {
        const gate = Reflect.get(window, key) as { held: () => boolean; expired: () => boolean };
        if (gate.expired()) throw new Error("The submission acknowledgement gate expired.");
        return gate.held();
      }, SEND_GATE_KEY, { timeout: timeoutMs });
      await handle.dispose();
    },
    release: async () => {
      await page.evaluate((key) => {
        const gate = Reflect.get(window, key) as { release: () => void } | undefined;
        gate?.release();
      }, SEND_GATE_KEY);
    },
  };
}

export async function refreshCapturedRuntimeSnapshot(page: Page): Promise<void> {
  await page.evaluate(async (key) => {
    const sockets = Reflect.get(window, key) as WebSocket[] | undefined;
    const socket = sockets?.find(({ readyState }) => readyState === WebSocket.OPEN);
    if (!socket) throw new Error("The captured runtime socket is unavailable.");
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      let acknowledged = false;
      const finish = (error?: unknown): void => {
        clearTimeout(timeout);
        socket.removeEventListener("message", receive);
        if (error) reject(error);
        else resolve();
      };
      const receive = (message: MessageEvent<string>): void => {
        const frame = JSON.parse(message.data) as ServerEvent;
        const event = frame.type === "runtime.event" ? frame.event : frame;
        if (event.type === "request.ok" && event.requestId === requestId) acknowledged = true;
        if (acknowledged && event.type === "snapshot.updated") finish();
      };
      const timeout = setTimeout(() => finish(new Error("Snapshot refresh did not settle.")), 5_000);
      socket.addEventListener("message", receive);
      try {
        socket.send(JSON.stringify({ type: "app.refresh", requestId }));
      } catch (error) {
        finish(error);
      }
    });
  }, SOCKETS_KEY);
}

export async function capturePageWebSockets(page: Page): Promise<void> {
  await page.addInitScript(({ key, gateKey }) => {
    const NativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    const CapturedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList) {
        const socket = Reflect.construct(target, argumentsList) as WebSocket;
        // WebSocket dispatches at one EventTarget, so late capture listeners
        // cannot intercept an earlier application listener. Install first.
        socket.addEventListener("message", (message: MessageEvent<string>) => {
          const gate = Reflect.get(window, gateKey) as {
            receive: (source: WebSocket, event: MessageEvent<string>) => void;
          } | undefined;
          gate?.receive(socket, message);
        });
        sockets.push(socket);
        return socket;
      },
    });
    Object.defineProperty(window, key, {
      configurable: true,
      value: sockets,
    });
    window.WebSocket = CapturedWebSocket as typeof WebSocket;
  }, { key: SOCKETS_KEY, gateKey: SEND_GATE_KEY });
}

export async function publishCapturedWebSocketEvent(
  page: Page,
  event: object,
): Promise<void> {
  await page.evaluate(({ key, fixtureEvent }) => {
    const sockets = Reflect.get(window, key) as WebSocket[] | undefined;
    const socket = sockets?.find(
      ({ readyState }) => readyState === WebSocket.OPEN,
    );
    if (!socket) {
      throw new Error("The captured fixture WebSocket is unavailable.");
    }
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(fixtureEvent),
    }));
  }, { key: SOCKETS_KEY, fixtureEvent: event });
}
