import type { Page } from "@playwright/test";

const SOCKETS_KEY = "__inertiaE2eCapturedWebSockets";

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
