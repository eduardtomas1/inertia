import type { Page } from "@playwright/test";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  RemoteDesktopCompatibility,
  RemoteSafeConversation,
  RemoteSafeConversationDetail,
} from "../../../src/shared/remote-protocol";

export interface SeededBrowserProfile {
  hostId: string;
  deviceId: string;
  endpointId: string;
  publicKey: string;
  expiresAt: string;
}

export function lifecycleDetail(
  conversation: RemoteSafeConversation,
  messageCount: number,
  createdAt: string,
): RemoteSafeConversationDetail {
  return {
    generatedAt: new Date().toISOString(),
    conversation,
    messages: Array.from({ length: messageCount }, (_value, index) => ({
      id: `message-${index}`,
      turnId: null,
      role: "assistant" as const,
      content: `Lifecycle message ${index} ${"content ".repeat(8)}`,
      createdAt,
    })),
    activities: [{
      id: "activity-1",
      turnId: null,
      kind: "status",
      title: "Lifecycle activity",
      status: "running",
      createdAt,
    }],
    subagents: [],
    waitingForLocalAction: false,
  };
}

export async function seedBrowserProfile(
  page: Page,
  input: {
    hostPublicKey: string;
    relayUrl: string;
    expiresAt: string;
    hostId?: string;
    deviceId?: string;
    endpointId?: string;
    relayIdentity: string;
    scopes?: Array<"view" | "prompt">;
  },
): Promise<SeededBrowserProfile> {
  return await page.evaluate(async ({
    hostPublicKey,
    relayUrl: url,
    expiresAt,
    hostId: requestedHostId,
    deviceId: requestedDeviceId,
    endpointId: requestedEndpointId,
    relayIdentity,
    scopes,
    desktop,
  }) => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ) as CryptoKeyPair;
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.publicKey),
    );
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    const publicKey = btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const hostId = requestedHostId ?? crypto.randomUUID();
    const deviceId = requestedDeviceId ?? crypto.randomUUID();
    const endpointId = requestedEndpointId ?? "lifecycle_endpoint";
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
        version: 2,
        deviceId,
        deviceLabel: "Lifecycle browser",
        publicKey,
        privateKey: keys.privateKey,
        lastUsedAt: new Date().toISOString(),
        hostId,
        hostPublicKey,
        relayUrl: url,
        relayIdentity,
        desktop,
        endpointId,
        scopes: scopes ?? ["view"],
        projectIds: ["safe-project"],
        grantVersion: 1,
        expiresAt,
      }, "active-sealed");
      transaction.oncomplete = () => resolveWrite();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return { hostId, deviceId, endpointId, publicKey, expiresAt };
  }, { ...input, desktop: {
    kind: "desktop",
    version: "0.2.0",
    relayProtocol: { minimum: 2, maximum: 2 },
    remoteProtocol: { minimum: 2, maximum: 2 },
  } satisfies RemoteDesktopCompatibility });
}

export async function serveBrowserAsset(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const requestPath = new URL(
      request.url ?? "/missing",
      "http://remote-companion.invalid",
    ).pathname;
    const path = requestPath === "/"
      ? resolve(root, "index.html")
      : resolve(root, requestPath.replace(/^\/+/u, ""));
    const nested = relative(root, path);
    if (
      nested === ".."
      || nested.startsWith(`..${sep}`)
      || isAbsolute(nested)
    ) {
      throw new Error("outside root");
    }
    const bytes = await readFile(path);
    const contentType = extname(path) === ".html"
      ? "text/html; charset=utf-8"
      : extname(path) === ".css"
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src ws: wss:",
        "img-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}
