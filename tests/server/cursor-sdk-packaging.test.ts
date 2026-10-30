import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCursorSdkDistributionLocation } from "../../src/server/provider/cursor-sdk-installation";

describe("Cursor SDK packaging boundary", () => {
  it("keeps exact runtime dependencies and lazy platform assets outside ASAR for external Node", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { dependencies: Record<string, string>; build: { asarUnpack: string[]; electronFuses: { runAsNode: boolean } } };
    expect(manifest.dependencies["@cursor/sdk"]).toBe("1.0.38");
    expect(manifest.build.electronFuses.runAsNode).toBe(false);
    expect(manifest.build.asarUnpack).toEqual(expect.arrayContaining(["out/main/**", "node_modules/@cursor/**", "node_modules/@bufbuild/**", "node_modules/@connectrpc/**", "node_modules/@statsig/**", "node_modules/zod/**"]));
    expect(readdirSync(resolve("node_modules/@cursor/sdk/dist/cjs")).some((name) => /^\d+\.js$/u.test(name))).toBe(true);
  });
  it("blocks packaged availability while exact platform notices are unresolved", () => {
    expect(() => assertCursorSdkDistributionLocation("file:///app/resources/app.asar/out/main/runtime-worker.js")).toThrow("third-party notices");
    expect(() => assertCursorSdkDistributionLocation("file:///app/resources/app.asar.unpacked/out/main/chunks/runtime.js")).toThrow("third-party notices");
    expect(() => assertCursorSdkDistributionLocation("file:///development/out/main/runtime-worker.js")).not.toThrow();
  });
});
