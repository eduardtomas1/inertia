import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const verifier = readFileSync(resolve(root, "scripts/verify-electron-fuses.mjs"), "utf8");
const table = verifier.slice(verifier.indexOf("const EXPECTED_FUSES = ["));
const expected = [...table.slice(0, table.indexOf("];")).matchAll(/\["(\w+)", (true|false)\]/gu)]
  .map(([, name, enabled]) => [name!, enabled === "true"] as const);
const configured = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  build: { electronFuses: Record<string, boolean> };
}).build.electronFuses;
const BUILDER_UNSUPPORTED_FUSES = new Set(["WasmTrapHandlers"]);

describe("Electron fuse configuration", () => {
  it("explicitly configures every verified fuse that electron-builder can set", () => {
    expect(expected).toHaveLength(9);
    expect(Object.fromEntries(expected
      .filter(([name]) => !BUILDER_UNSUPPORTED_FUSES.has(name))
      .map(([name, enabled]) => [`${name[0]!.toLowerCase()}${name.slice(1)}`, enabled])))
      .toEqual(configured);
  });
});
