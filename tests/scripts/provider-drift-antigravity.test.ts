import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAntigravityManifest, stageAntigravityCli } from "../../scripts/provider-drift-antigravity.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const archive = Buffer.from("checksum-verified fixture archive");
const manifest = {
  version: "1.2.11",
  url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.11-6016716732497920/linux-x64/cli_linux_x64.tar.gz",
  sha512: createHash("sha512").update(archive).digest("hex"),
};

describe("Antigravity secret-free canary artifact", () => {
  it.each([
    { url: "https://example.test/agy" },
    { url: `${manifest.url}?redirect=elsewhere` },
    { url: manifest.url.replace("antigravity-public/", "another-bucket/") },
    { url: manifest.url.replace("https:", "http:") },
    { sha512: "invalid" },
    { version: "unbounded\nmetadata" },
  ])("rejects an untrusted manifest: %j", (override) => {
    expect(() => parseAntigravityManifest(JSON.stringify({ ...manifest, ...override }))).toThrow();
  });

  it.each([false, true])("verifies bytes before extraction (corrupt=%s)", async (corrupt) => {
    const root = await mkdtemp(join(tmpdir(), "inertia-antigravity-canary-"));
    roots.push(root);
    const isolated = join(root, "artifact");
    const environment = { HOME: join(root, "private-home") };
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "tar") {
        if (args.includes("--list")) return "-rwxr-xr-x 0/0 14 2026-09-26 12:00 antigravity\n";
        expect(args).toContain("--no-same-owner");
        expect(args.at(-1)).toBe("antigravity");
        await writeFile(join(isolated, "antigravity"), "fixture binary");
      } else if (args.includes("--output")) {
        await writeFile(args[args.indexOf("--output") + 1]!, corrupt ? "corrupt" : archive);
      } else return JSON.stringify(manifest);
      return "";
    });
    const result = stageAntigravityCli(isolated, environment, run);
    if (corrupt) {
      await expect(result).rejects.toThrow("checksum");
      expect(run.mock.calls.every(([command]) => command !== "tar")).toBe(true);
    } else {
      await expect(result).resolves.toEqual({ executable: join(isolated, "agy"), version: manifest.version });
      expect(await readFile(join(isolated, "agy"), "utf8")).toBe("fixture binary");
    }
    for (const call of run.mock.calls) expect(call[0]).not.toBe("bash");
  });

  it.each([
    "lrwxrwxrwx 0/0 0 2026-09-26 12:00 antigravity -> /outside",
    "-rwxr-xr-x 0/0 536870913 2026-09-26 12:00 antigravity",
    Array(2).fill("-rwxr-xr-x 0/0 14 2026-09-26 12:00 antigravity").join("\n"),
  ])("rejects unsafe archive entries before extraction: %s", async (listing) => {
    const root = await mkdtemp(join(tmpdir(), "inertia-antigravity-canary-"));
    roots.push(root);
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "tar") return listing;
      if (args.includes("--output")) {
        await writeFile(args[args.indexOf("--output") + 1]!, archive);
        return "";
      }
      return JSON.stringify(manifest);
    });
    await expect(stageAntigravityCli(join(root, "artifact"), {}, run)).rejects.toThrow("regular binary entry");
    expect(run.mock.calls.some(([, args]) => args.includes("--extract"))).toBe(false);
  });
});
