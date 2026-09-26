import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

// Published by https://antigravity.google/cli/install.sh. Download the
// checksum-verified native artifact; do not execute an upstream installer or
// its shell-profile setup. This probe currently runs on the Linux x64 canary.
export const ANTIGRAVITY_MANIFEST_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json";

export function parseAntigravityManifest(text) {
  const manifest = JSON.parse(text);
  if (!manifest || typeof manifest !== "object"
    || typeof manifest.version !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(manifest.version)
    || typeof manifest.sha512 !== "string"
    || !/^[a-f0-9]{128}$/u.test(manifest.sha512)
    || typeof manifest.url !== "string"
    || !/^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\/[A-Za-z0-9.-]+\/linux-x64\/cli_linux_x64\.tar\.gz$/u.test(manifest.url)) {
    throw new Error("Antigravity release manifest is not an approved Linux x64 artifact.");
  }
  return { version: manifest.version, url: manifest.url, sha512: manifest.sha512 };
}

export async function stageAntigravityCli(root, environment, run) {
  // A fresh private extraction directory prevents existing links from changing
  // tar's destination. Only the single named binary is extracted.
  await mkdir(root, { mode: 0o700 });
  const download = ["--fail", "--silent", "--show-error", "--proto", "=https",
    "--connect-timeout", "20", "--max-time", "120"];
  const options = { cwd: root, environment: { ...environment, LC_ALL: "C" }, timeoutMs: 130_000 };
  const manifest = parseAntigravityManifest(await run("curl", [
    ...download, "--max-filesize", "65536", ANTIGRAVITY_MANIFEST_URL,
  ], options));
  const archive = join(root, "agy.tar.gz");
  await run("curl", [
    ...download, "--max-filesize", "268435456", "--output", archive, manifest.url,
  ], { ...options, allowEmpty: true });
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== manifest.sha512) {
    throw new Error("Antigravity archive checksum does not match its official manifest.");
  }
  const listing = await run("tar", ["--list", "--verbose", "--numeric-owner", "--gzip",
    "--file", archive, "--", "antigravity"], { ...options, timeoutMs: 30_000 });
  const entry = /^-[-rwxstST]{9}\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+antigravity$/u
    .exec(listing.trim());
  if (!entry || Number(entry[1]) <= 0 || Number(entry[1]) > 512 * 1024 * 1024) {
    throw new Error("Antigravity archive must contain one bounded regular binary entry.");
  }
  await run("tar", ["--extract", "--gzip", "--file", archive,
    "--directory", root, "--no-same-owner", "--", "antigravity"],
  { ...options, allowEmpty: true, timeoutMs: 30_000 });
  const extracted = join(root, "antigravity");
  const metadata = await lstat(extracted);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 512 * 1024 * 1024) {
    throw new Error("Antigravity archive did not contain one bounded regular binary.");
  }
  const executable = join(root, "agy");
  await rename(extracted, executable);
  await chmod(executable, 0o700);
  return { executable, version: manifest.version };
}
