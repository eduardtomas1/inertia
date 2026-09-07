import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { downloadBoundedFile, fetchBoundedText, releaseAssetChecksum } from "./ci/download-windows-n-minus-one.mjs";

const name = "Inertia-0.0.54.AppImage";
const url = `https://github.com/eduardtomas1/inertia/releases/download/v0.0.54/${name}`;
const maxBytes = 512 * 1024 * 1024;

export function validatePublicTarget(release, checksums, expectedDigest) {
  assert.match(expectedDigest, /^[a-f0-9]{64}$/u);
  assert.equal(release.tag_name, "v0.0.54");
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert(Array.isArray(release.assets) && release.assets.length <= 64);
  const assets = release.assets.filter(asset => asset.name === name);
  assert.equal(assets.length, 1);
  const asset = assets[0];
  assert(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maxBytes);
  assert.equal(asset.browser_download_url, url);
  assert.equal(asset.digest, `sha256:${expectedDigest}`);
  assert.equal(releaseAssetChecksum(checksums, name), expectedDigest);
  return { version: "0.0.54", name, size: asset.size, sha256: expectedDigest };
}

export async function readPublicTarget(expectedDigest) {
  const timeouts = { connectTimeoutMs: 10_000, bodyTimeoutMs: 10_000 };
  const release = JSON.parse(await fetchBoundedText(
    "https://api.github.com/repos/eduardtomas1/inertia/releases/tags/v0.0.54",
    2 * 1024 * 1024, "", "application/vnd.github+json", timeouts,
  ));
  const checksums = await fetchBoundedText(
    "https://github.com/eduardtomas1/inertia/releases/download/v0.0.54/SHA256SUMS.txt",
    65_536, "", "application/octet-stream", timeouts,
  );
  return validatePublicTarget(release, checksums, expectedDigest);
}

export async function downloadPublicTarget(directory, expectedDigest) {
  assert(isAbsolute(directory));
  const target = await readPublicTarget(expectedDigest);
  // This one-use directory must be fresh; never replace an existing candidate.
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, target.name);
  await downloadBoundedFile(url, path, target.size, "");
  await verifyTargetFile(path, target);
  await chmod(path, 0o755);
  return { ...target, checksumVerified: true, publicArtifact: true };
}

export async function verifyPrivateDownloadedTarget(root, target) {
  assert.equal(target.name, name);
  assert.match(target.sha256, /^[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(target.size) && target.size > 0 && target.size <= maxBytes);
  // The pinned public v53 package is named inertia; its shipped builder uses
  // sanitizedName.toLowerCase() + '-updater', under the private XDG_CACHE_HOME.
  let directory = await realpath(root);
  for (const part of ["cache", "inertia-updater", "pending"]) {
    directory = join(directory, part);
    const metadata = await lstat(directory);
    assert(metadata.isDirectory() && !metadata.isSymbolicLink());
    assert.equal(await realpath(directory), directory);
  }
  let count = 0;
  let matches = 0;
  for await (const entry of await opendir(directory)) {
    assert(++count <= 16, "Private updater cache exceeded its entry limit.");
    if (entry.name.endsWith(".AppImage")) {
      assert.equal(entry.name, name);
      assert(entry.isFile() && !entry.isSymbolicLink());
      matches++;
    }
  }
  assert.equal(matches, 1);
  return await verifyTargetFile(join(directory, name), target);
}

async function verifyTargetFile(path, target) {
  const before = await lstat(path);
  assert(before.isFile() && !before.isSymbolicLink() && before.size === target.size);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assert(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === target.size);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal: AbortSignal.timeout(10_000) })) {
      bytes += chunk.length;
      assert(bytes <= target.size);
      hash.update(chunk);
    }
    assert.equal(bytes, target.size);
    const after = await handle.stat();
    assert(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs);
    const digest = hash.digest("hex");
    assert.equal(digest, target.sha256);
    return { name, size: bytes, sha256: digest, checksumVerified: true };
  } finally { await handle.close(); }
}
