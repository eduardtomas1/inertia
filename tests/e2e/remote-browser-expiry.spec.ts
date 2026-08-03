import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";

import { WebSocketServer } from "ws";

import { generateRemoteKeyPair } from "../../src/shared/remote-crypto";
import { REMOTE_DESKTOP_COMPATIBILITY } from "../../src/shared/remote-protocol";
import {
  seedBrowserProfile,
  serveBrowserAsset,
} from "./support/remote-browser-fixtures";
import {
  closeRemoteBrowserRelayResources,
  launchRemoteBrowser,
} from "./support/remote-browser-electron-fixture";

let staticServer: Server;
let staticUrl: string;

test.beforeAll(async () => {
  const root = resolve("remote/browser/dist");
  staticServer = createServer((request, response) => {
    void serveBrowserAsset(root, request, response);
  });
  staticServer.listen(0, "127.0.0.1");
  await once(staticServer, "listening");
  const address = staticServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Browser test server did not bind.");
  }
  staticUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolveClose) =>
    staticServer.close(() => resolveClose()));
});

test("reports expired sealed and legacy grants without starting transport", async () => {
  const silentRelay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let connections = 0;
  silentRelay.on("connection", () => {
    connections += 1;
  });
  let browser: Awaited<ReturnType<typeof launchRemoteBrowser>> | null = null;
  try {
    await once(silentRelay, "listening");
    const address = silentRelay.address();
    if (!address || typeof address === "string") {
      throw new Error("Silent relay did not bind.");
    }
    const hostKeys = await generateRemoteKeyPair();
    const relayUrl = `ws://127.0.0.1:${address.port}/remote`;
    browser = await launchRemoteBrowser({
      staticUrl,
      ready: async (page) => {
        await expect(page.getByRole("heading", { name: "Pair this browser" }))
          .toBeVisible();
      },
    });
    const { page } = browser;
    await seedBrowserProfile(page, {
      hostPublicKey: hostKeys.publicKey,
      relayUrl,
      relayIdentity: crypto.randomUUID(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await navigateRemoteBrowser(page, "sealed-grant-expiry");
    await expectExpiredPairing(page);
    await page.waitForTimeout(100);
    expect(connections).toBe(0);

    await seedLegacyBrowserProfile(page, {
      hostPublicKey: hostKeys.publicKey,
      relayUrl,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await navigateRemoteBrowser(page, "legacy-grant-expiry");
    await expectExpiredPairing(page);
    await page.waitForTimeout(100);
    expect(connections).toBe(0);
  } finally {
    await closeRemoteBrowserRelayResources(browser, silentRelay);
  }
});

async function expectExpiredPairing(page: Page): Promise<void> {
  await expect(page.getByText("This device grant expired. Pair it again."))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Pair this browser" }))
    .toBeVisible();
}

async function navigateRemoteBrowser(page: Page, label: string): Promise<void> {
  await page.goto(`${staticUrl}/?fixture=${encodeURIComponent(label)}`, {
    waitUntil: "load",
  });
}

async function seedLegacyBrowserProfile(
  page: Page,
  input: {
    hostPublicKey: string;
    relayUrl: string;
    expiresAt: string;
  },
): Promise<void> {
  const keyPair = await generateRemoteKeyPair();
  await page.evaluate(async ({ deviceKeys, hostPublicKey, relayUrl, expiresAt,
    desktop }) => {
    const db = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const opening = indexedDB.open("inertia-remote-companion", 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore("device");
      };
      opening.onsuccess = () => resolveDatabase(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    await new Promise<void>((resolveWrite, reject) => {
      const transaction = db.transaction("device", "readwrite");
      transaction.objectStore("device").put({
        version: 1,
        deviceId: crypto.randomUUID(),
        deviceLabel: "Legacy browser",
        keyPair: deviceKeys,
        hostId: crypto.randomUUID(),
        hostPublicKey,
        relayUrl,
        relayIdentity: crypto.randomUUID(),
        desktop,
        endpointId: "legacy_endpoint",
        scopes: ["view"],
        projectIds: ["safe-project"],
        grantVersion: 1,
        expiresAt,
      }, "active");
      transaction.oncomplete = () => resolveWrite();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, {
    deviceKeys: keyPair,
    ...input,
    desktop: REMOTE_DESKTOP_COMPATIBILITY,
  });
}
