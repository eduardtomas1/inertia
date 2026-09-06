import type { Page } from "@playwright/test";
import type { ServerEvent } from "../../../src/shared/contracts";

const SOCKETS_KEY = "__inertiaE2eCapturedWebSockets";

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
  await page.addInitScript((key) => {
    const NativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    const CapturedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, argumentsList) {
        const socket = Reflect.construct(target, argumentsList) as WebSocket;
        sockets.push(socket);
        return socket;
      },
    });
    Object.defineProperty(window, key, {
      configurable: true,
      value: sockets,
    });
    window.WebSocket = CapturedWebSocket as typeof WebSocket;
  }, SOCKETS_KEY);
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
