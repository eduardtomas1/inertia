import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { downloadBoundedFile, fetchBoundedText, releaseAssetChecksum } from "./download-windows-n-minus-one.mjs";

const repository = "eduardtomas1/inertia";
const tag = "v0.0.53";
const name = "Inertia-0.0.53.AppImage";
const size = 360582286;
const sha256 = "81621b079ed09b820e1dc7e33d496394223c8235ef6d209c623acd44846fe8b2";
const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
const root = resolve(process.argv[2]);
const release = JSON.parse(await fetchBoundedText(`https://api.github.com/repos/${repository}/releases/tags/${tag}`,
  2 * 1024 * 1024, "", "application/vnd.github+json"));
if (release.tag_name !== tag || release.draft || release.prerelease) throw new Error("Public predecessor identity mismatch.");
const assets = release.assets.filter(asset => asset.name === name);
if (assets.length !== 1 || assets[0].size !== size || assets[0].browser_download_url !== url
  || assets[0].digest !== `sha256:${sha256}`) throw new Error("Public predecessor asset mismatch.");
const checksums = await fetchBoundedText(`https://github.com/${repository}/releases/download/${tag}/SHA256SUMS.txt`,
  65536, "", "application/octet-stream");
if (releaseAssetChecksum(checksums, name) !== sha256) throw new Error("Public predecessor checksum mismatch.");
await mkdir(root, { recursive: true, mode: 0o700 });
const path = join(root, name);
await downloadBoundedFile(url, path, size, "");
const hash = createHash("sha256");
for await (const chunk of createReadStream(path)) hash.update(chunk);
if (hash.digest("hex") !== sha256) throw new Error("Downloaded predecessor digest mismatch.");
await chmod(path, 0o755);
await writeFile(join(root, "predecessor.json"), `${JSON.stringify({ repository, tag, name, size, sha256, url })}\n`, { mode: 0o600 });
console.log(JSON.stringify({ event: "verified-public-predecessor", tag, name, size, sha256 }));
