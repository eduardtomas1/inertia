import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { build } from "vite";

const root = resolve("src/renderer/private-connect");
const outputRoot = resolve("out/private-connect");
await build({ configFile: resolve(root, "vite.config.ts") });

const iconRoot = resolve(outputRoot, "icons");
await mkdir(iconRoot, { recursive: true });

async function copyPng(source, target, size) {
  await copyFile(source, target);
  const png = await readFile(target);
  if (
    png.length < 24
    || png.toString("ascii", 1, 4) !== "PNG"
    || png.readUInt32BE(16) !== size
    || png.readUInt32BE(20) !== size
  ) throw new Error(`Packaged icon ${target} is not ${size}x${size}.`);
}

await Promise.all([
  copyPng(resolve("resources/icons/192x192.png"), resolve(iconRoot, "inertia-192.png"), 192),
  copyPng(resolve("resources/icons/512x512.png"), resolve(iconRoot, "inertia-512.png"), 512),
]);

async function outputFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? outputFiles(path) : [path];
  }));
  return files.flat();
}

const shellFiles = (await outputFiles(outputRoot))
  .filter((path) => !path.endsWith(`${sep}service-worker.js`))
  .sort();
const shellPaths = shellFiles.map((path) => {
  const outputPath = relative(outputRoot, path).split(sep).join("/");
  return outputPath === "index.html" ? "/" : `/${outputPath}`;
});
const shellDigest = createHash("sha256");
for (const [index, path] of shellFiles.entries()) {
  shellDigest.update(shellPaths[index]);
  shellDigest.update("\0");
  shellDigest.update(await readFile(path));
  shellDigest.update("\0");
}
const cacheName = `inertia-private-connect-shell-${shellDigest.digest("hex").slice(0, 16)}`;
const workerSource = `"use strict";
const CACHE_PREFIX = "inertia-private-connect-shell-";
const CACHE_NAME = ${JSON.stringify(cacheName)};
const APP_SHELL = Object.freeze(${JSON.stringify(shellPaths)});
const APP_SHELL_PATHS = new Set(APP_SHELL);
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      const cached = await caches.match("/");
      return cached ?? Response.error();
    }));
    return;
  }
  if (!APP_SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(caches.match(url.pathname).then((cached) => cached ?? fetch(request)));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const candidate = event.notification.data?.conversationId;
  const conversationId = typeof candidate === "string" && CONVERSATION_ID.test(candidate)
    ? candidate
    : null;
  const target = conversationId ? "/#conversation=" + conversationId : "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const client = clients[0];
    if (client) {
      if (conversationId) client.postMessage({ type: "private-connect.open-conversation", conversationId });
      await client.focus();
      return;
    }
    await self.clients.openWindow(target);
  }));
});
`;
await writeFile(resolve(outputRoot, "service-worker.js"), workerSource, "utf8");

console.log("Built the packaged Inertia Private Connect web client.");
