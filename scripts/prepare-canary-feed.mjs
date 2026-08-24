import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { parseDocument, stringify } from "yaml";

const sourceDirectory = resolve(process.env.INERTIA_CANARY_ASSET_DIR ?? "release-assets/final");
const outputDirectory = resolve(process.env.INERTIA_CANARY_FEED_DIR ?? "canary-feed");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = packageJson.version;
const tag = process.env.RELEASE_TAG;
if (tag !== `canary-v${version}`) {
  throw new Error("Canary feed preparation requires the exact canary-v<package.version> tag.");
}

const availableAssets = new Set(await readdir(sourceDirectory));
for (const name of ["canary-linux.yml", "canary-linux-arm64.yml"]) {
  if (!availableAssets.has(name)) {
    throw new Error("Canary feed preparation requires both Linux architecture metadata files.");
  }
}
const metadataNames = [
  "canary-mac.yml",
  "canary.yml",
  "canary-linux.yml",
  "canary-linux-arm64.yml",
]
  .filter((name) => availableAssets.has(name));
const releaseBase = `https://github.com/eduardtomas1/inertia/releases/download/${tag}`;
await mkdir(outputDirectory, { recursive: true });

for (const name of metadataNames) {
  const source = await readFile(join(sourceDirectory, name), "utf8");
  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`Invalid Canary update metadata: ${name}`);
  }
  const value = document.toJS({ maxAliasCount: 0 });
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || value.version !== version
    || !Array.isArray(value.files)
  ) throw new Error(`Unexpected Canary update metadata: ${name}`);
  for (const file of value.files) {
    if (
      typeof file !== "object"
      || file === null
      || Array.isArray(file)
      || typeof file.url !== "string"
      || basename(file.url) !== file.url
      || !/^[A-Za-z0-9._-]{1,180}$/u.test(file.url)
    ) throw new Error(`Unsafe Canary package reference in ${name}.`);
    file.url = `${releaseBase}/${file.url}`;
  }
  await writeFile(join(outputDirectory, name), stringify(value), {
    encoding: "utf8",
    flag: "wx",
  });
}

await writeFile(
  join(outputDirectory, "canary-status.json"),
  `${JSON.stringify({ version, tag }, null, 2)}\n`,
  { encoding: "utf8", flag: "wx" },
);

console.log(`Prepared atomic Canary feed for ${tag}.`);
