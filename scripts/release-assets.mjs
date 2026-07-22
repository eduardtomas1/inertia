import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const command = process.argv[2] ?? "";
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = packageJson.version;
if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
  throw new Error("Release assets require a strict stable package version.");
}

const platforms = {
  "macos-arm64": [
    `Inertia-${version}-arm64.dmg`,
    `Inertia-${version}-arm64-mac.zip`,
  ],
  "windows-x64": [`Inertia.Setup.${version}.exe`],
  "linux-x64": [`Inertia-${version}.AppImage`],
};

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileMetadata(path) {
  const value = await stat(path);
  if (!value.isFile() || value.size <= 0) throw new Error(`Release asset is missing or empty: ${path}`);
  return { name: basename(path), size: value.size, sha256: await sha256(path) };
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

if (command === "stage") {
  const platform = process.argv[3] ?? "";
  const expectedNames = platforms[platform];
  if (!expectedNames) throw new Error(`Unknown release platform: ${platform}`);
  const stagingRoot = resolve(process.env.INERTIA_RELEASE_STAGE_DIR ?? "release-upload");
  const platformDirectory = join(stagingRoot, platform);
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(platformDirectory);
  const assets = [];
  for (const name of expectedNames) {
    const source = resolve("release", name);
    const metadata = await fileMetadata(source);
    await copyFile(source, join(platformDirectory, name), constants.COPYFILE_EXCL);
    assets.push(metadata);
  }
  await writeFile(
    join(platformDirectory, "manifest.json"),
    `${JSON.stringify({ version, platform, assets }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(`Staged ${assets.length} ${platform} release asset(s).`);
} else if (command === "finalize") {
  const downloadRoot = resolve(process.env.INERTIA_RELEASE_DOWNLOAD_DIR ?? "release-assets");
  const finalDirectory = join(downloadRoot, "final");
  await mkdir(finalDirectory);
  const combined = [];
  for (const [platform, expectedNames] of Object.entries(platforms)) {
    const platformDirectory = join(downloadRoot, platform);
    const entries = (await readdir(platformDirectory)).sort();
    const expectedEntries = [...expectedNames, "manifest.json"].sort();
    if (!sameStrings(entries, expectedEntries)) throw new Error(`Unexpected ${platform} artifact file set: ${entries.join(", ")}`);
    const manifest = JSON.parse(await readFile(join(platformDirectory, "manifest.json"), "utf8"));
    if (manifest.version !== version || manifest.platform !== platform || !Array.isArray(manifest.assets)) {
      throw new Error(`Invalid ${platform} artifact manifest.`);
    }
    const manifestNames = manifest.assets.map((asset) => asset?.name).sort();
    if (!sameStrings(manifestNames, [...expectedNames].sort())) throw new Error(`Invalid ${platform} manifest asset set.`);
    for (const expectedName of expectedNames) {
      const path = join(platformDirectory, expectedName);
      const actual = await fileMetadata(path);
      const recorded = manifest.assets.find((asset) => asset?.name === expectedName);
      if (!recorded || actual.size !== recorded.size || actual.sha256 !== recorded.sha256) {
        throw new Error(`Artifact integrity mismatch for ${expectedName}.`);
      }
      await copyFile(path, join(finalDirectory, expectedName), constants.COPYFILE_EXCL);
      combined.push(actual);
    }
  }
  combined.sort((left, right) => left.name.localeCompare(right.name, "en"));
  await writeFile(
    join(finalDirectory, "SHA256SUMS.txt"),
    combined.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n") + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  const finalEntries = (await readdir(finalDirectory)).sort();
  const expectedFinalEntries = [...combined.map((asset) => asset.name), "SHA256SUMS.txt"].sort();
  if (!sameStrings(finalEntries, expectedFinalEntries)) throw new Error("Unexpected consolidated release asset file set.");
  console.log(`Finalized ${combined.length} release assets and SHA256SUMS.txt for v${version}.`);
} else {
  throw new Error("Usage: node scripts/release-assets.mjs stage <platform> | finalize");
}
