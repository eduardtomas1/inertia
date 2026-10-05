import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readHomebrewInfo } from "../../src/server/provider/maintenance-homebrew-latest";

const posixIt = it.skipIf(process.platform === "win32");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fakeBrew(body: string): Promise<{ brew: string; record: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-brew-info-")));
  roots.push(root);
  const record = join(root, "record.json");
  const brew = join(root, "brew");
  await writeFile(brew, [
    `#!${process.execPath}`,
    "const fs = require(\"node:fs\");",
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: { HOMEBREW_NO_AUTO_UPDATE: process.env.HOMEBREW_NO_AUTO_UPDATE, HOMEBREW_NO_ANALYTICS: process.env.HOMEBREW_NO_ANALYTICS, OPENAI_API_KEY: process.env.OPENAI_API_KEY } }));`,
    body,
    "",
  ].join("\n"), { mode: 0o755 });
  return { brew, record };
}

describe("Homebrew latest-version reader", () => {
  posixIt("runs brew info without a shell, auto-update or provider secrets and returns its JSON", async () => {
    const json = JSON.stringify({ formulae: [], casks: [{ version: "0.160.0" }] });
    const { brew, record } = await fakeBrew(`process.stdout.write(${JSON.stringify(json)});`);
    await expect(readHomebrewInfo(brew, ["info", "--json=v2", "--cask", "codex"], {
      environment: { PATH: "/usr/bin:/bin", HOME: tmpdir(), OPENAI_API_KEY: "secret" },
    })).resolves.toBe(json);
    expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
      argv: ["info", "--json=v2", "--cask", "codex"],
      env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1" },
    });
  });

  posixIt.each([
    ["exits with an error", "process.exit(1);"],
    ["prints more than the output bound", "process.stdout.write(\"x\".repeat(80 * 1024));"],
  ])("returns nothing when brew %s", async (_case, body) => {
    const { brew } = await fakeBrew(body);
    await expect(readHomebrewInfo(brew, ["info", "--json=v2", "--formula", "opencode"], {
      environment: { PATH: "/usr/bin:/bin", HOME: tmpdir() },
    })).resolves.toBeNull();
  });

  posixIt("stops a brew that does not answer within its deadline", async () => {
    const { brew } = await fakeBrew("setInterval(() => undefined, 1000);");
    const started = Date.now();
    await expect(readHomebrewInfo(brew, ["info", "--json=v2", "--formula", "codex"], {
      environment: { PATH: "/usr/bin:/bin", HOME: tmpdir() },
      timeoutMs: 1_000,
    })).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});
