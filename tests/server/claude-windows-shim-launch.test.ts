// @inertia-test-suite portable
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createClaudeOwnedQueryProcess } from "../../src/server/provider/claude-owned-query";
import { removePortableFixture } from "../helpers/portable-provider-fixture";

const MANAGED_SETTINGS = "{\"disableAllHooks\":true,\"note\":\"quote \\\" & percent % and caret ^\"}";

describe.runIf(process.platform === "win32")("Claude npm shim launch on Windows", () => {
  it("delivers a quoted JSON argument to the package entry byte for byte without a shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia claude shim "));
    try {
      const packageDirectory = join(root, "node_modules", "@anthropic-ai", "claude-code");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
        name: "@anthropic-ai/claude-code",
        bin: { claude: "cli.js" },
      }));
      writeFileSync(
        join(packageDirectory, "cli.js"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)) + \"\\n\");\n",
      );
      writeFileSync(join(root, "claude.cmd"), "@echo off\r\nexit /b 9\r\n");
      copyFileSync(process.execPath, join(root, "node.exe"));
      const owned = createClaudeOwnedQueryProcess("Claude shim launch fixture");
      const spawned = owned.spawnClaudeCodeProcess({
        command: join(root, "claude.cmd"),
        args: ["--managed-settings", MANAGED_SETTINGS],
        cwd: root,
        env: { ...process.env },
        signal: new AbortController().signal,
      });
      const closed = once(owned.child()!, "close");
      let output = "";
      spawned.stdout.setEncoding("utf8");
      spawned.stdout.on("data", (chunk: string) => { output += chunk; });
      await once(spawned.stdout, "end");
      const [exitCode] = await closed;

      expect(JSON.parse(output.trim())).toEqual(["--managed-settings", MANAGED_SETTINGS]);
      expect(exitCode).toBe(0);
    } finally {
      await removePortableFixture(root);
    }
  });
});
