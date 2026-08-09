import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const root = resolve("src/renderer/private-connect");
await build({ configFile: resolve(root, "vite.config.ts") });

const iconRoot = resolve("out/private-connect/icons");
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

console.log("Built the packaged Inertia Private Connect web client.");
