import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { WebSocket, WebSocketServer } from "ws";

import {
  closeRemoteBrowserRelayResources,
  launchRemoteBrowser,
} from "./support/remote-browser-electron-fixture";

test("cleans a launched app and profile when readiness fails", async () => {
  const profilePrefix = `inertia-remote-cleanup-${randomUUID()}-`;
  const observed: { page: Page | null } = { page: null };

  await expect(launchRemoteBrowser({
    staticUrl: "data:text/html,<title>cleanup fixture</title>",
    profilePrefix,
    ready: async (launchedPage) => {
      observed.page = launchedPage;
      throw new Error("Injected readiness failure");
    },
  })).rejects.toThrow("Injected readiness failure");

  expect(observed.page?.isClosed()).toBe(true);
  expect((await readdir(tmpdir())).some((entry) =>
    entry.startsWith(profilePrefix))).toBe(false);
});

test("force-kills the owned tree before profile removal when close rejects", async () => {
  const profilePrefix = `inertia-remote-force-close-${randomUUID()}-`;
  const closeError = new Error("Injected close failure");
  const browser = await launchRemoteBrowser({
    staticUrl: "data:text/html,<title>forced cleanup fixture</title>",
    profilePrefix,
    closeApp: async () => {
      throw closeError;
    },
  });
  const child = browser.electronApp.process();

  await expect(browser.close()).rejects.toMatchObject({
    message: "Remote browser fixture cleanup failed.",
    errors: expect.arrayContaining([closeError]),
  });

  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(browser.page.isClosed()).toBe(true);
  expect((await readdir(tmpdir())).some((entry) =>
    entry.startsWith(profilePrefix))).toBe(false);
});

test("terminates relay clients even when browser cleanup fails", async () => {
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(relay, "listening");
  const address = relay.address();
  if (!address || typeof address === "string") {
    throw new Error("Cleanup relay did not bind.");
  }
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  try {
    await once(client, "open");
    expect(relay.clients.size).toBe(1);
    const browserError = new Error("Injected browser cleanup failure");
    const clientClosed = once(client, "close");

    await expect(closeRemoteBrowserRelayResources({
      close: async () => {
        throw browserError;
      },
    }, relay)).rejects.toMatchObject({
      message: "Remote browser fixture resource cleanup failed.",
      errors: [browserError],
    });

    await clientClosed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(relay.address()).toBeNull();
  } finally {
    if (client.readyState !== WebSocket.CLOSED) client.terminate();
    if (relay.address()) {
      await closeRemoteBrowserRelayResources(null, relay)
        .catch(() => undefined);
    }
  }
});
