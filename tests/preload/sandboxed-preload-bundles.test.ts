import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const SANDBOXED_PRELOADS = [
  "src/preload/index.ts",
  "src/preload/detached-chat.ts",
  "src/preload/mascot.ts",
  "src/preload/preview-agent-privacy.ts",
];

async function runtimeRequires(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  const requires = new Set<string>();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external) requires.add(imported.path);
    }
  }
  return [...requires].sort();
}

describe("sandboxed preload bundles", () => {
  it.each(SANDBOXED_PRELOADS)("%s requires only electron at runtime", async (entry) => {
    expect(await runtimeRequires(entry)).toEqual(["electron"]);
  }, 30_000);
});
