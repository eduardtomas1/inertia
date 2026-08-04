import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const root = resolve("src/renderer/private-connect");
await build({ configFile: resolve(root, "vite.config.ts") });

const iconRoot = resolve("out/private-connect/icons");
await mkdir(iconRoot, { recursive: true });
await Promise.all([
  copyFile(resolve("resources/icons/256x256.png"), resolve(iconRoot, "inertia-192.png")),
  copyFile(resolve("resources/icons/512x512.png"), resolve(iconRoot, "inertia-512.png")),
]);

console.log("Built the packaged Inertia Private Connect web client.");
