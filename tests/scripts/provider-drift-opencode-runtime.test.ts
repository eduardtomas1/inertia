import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ProcessTreeCleanupError,
  runBounded,
} from "../../scripts/bounded-process-tree.mjs";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat.lastIndexOf(")");
      if (tail >= 0 && stat.slice(tail + 2, tail + 3) === "Z") return false;
    }
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform !== "win32")(
  "provider drift OpenCode semantic isolation",
  () => {
    it("detects project-plugin execution by a --pure server", async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-opencode-pure-"));
      const command = join(root, "opencode-fixture");
      const pidMarker = join(root, "server.pid");
      const sentinel = join(root, "plugin-executed");
      let serverPid = 0;
      const runtime = join(
        process.cwd(),
        "scripts/provider-drift-opencode-runtime.mjs",
      );
      writeFileSync(command, [
        "#!/usr/bin/env node",
        'const { writeFileSync } = require("node:fs");',
        'const { createServer } = require("node:http");',
        'const pure = process.argv.includes("--pure");',
        'writeFileSync(process.env.OPENCODE_FIXTURE_PID, String(process.pid));',
        'if (!pure || process.env.OPENCODE_FIXTURE_LOADS_PLUGIN === "1") {',
        '  writeFileSync(process.env.OPENCODE_FIXTURE_SENTINEL, "executed");',
        "}",
        "const server = createServer((request, response) => {",
        '  response.setHeader("content-type", "application/json");',
        '  if (request.url.startsWith("/global/health")) return response.end(JSON.stringify({ healthy: true, version: "test" }));',
        '  if (request.url.startsWith("/provider")) return response.end(JSON.stringify({ all: [], default: {}, connected: [] }));',
        '  if (request.url.startsWith("/agent")) return response.end(JSON.stringify([]));',
        "  response.statusCode = 404; response.end(JSON.stringify({ error: 'missing' }));",
        "});",
        'server.listen(0, "127.0.0.1", () => {',
        '  console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`);',
        "});",
      ].join("\n"));
      chmodSync(command, 0o755);
      const run = async (mode: "discover" | "pure", loadsPlugin: boolean) => await runBounded(
        process.execPath,
        [runtime, command, root, sentinel, mode],
        {
          cwd: root,
          env: {
            ...process.env,
            OPENCODE_FIXTURE_LOADS_PLUGIN: loadsPlugin ? "1" : "0",
            OPENCODE_FIXTURE_PID: pidMarker,
            OPENCODE_FIXTURE_SENTINEL: sentinel,
          },
          label: `OpenCode ${mode} semantic fixture`,
          onSpawn: ({ pid, processGroupId }) => {
            if (processGroupId !== pid) throw new Error("Fixture ownership admission failed.");
          },
          timeoutMs: 10_000,
        },
      );
      try {
        await expect(run("discover", true)).resolves.toContain(
          "project plugin semantic control passed",
        );
        expect(existsSync(sentinel)).toBe(true);
        unlinkSync(sentinel);
        let failure: unknown;
        try {
          await run("pure", true);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(ProcessTreeCleanupError);
        expect((failure as Error).message.split("\n")[0]).toBe(
          "OpenCode pure semantic fixture exited with status 1.",
        );
        expect((failure as Error).message).toContain(
          "OpenCode --pure executed an external project plugin",
        );
        serverPid = Number.parseInt(readFileSync(pidMarker, "utf8"), 10);
        expect(processExists(serverPid)).toBe(false);
      } finally {
        if (serverPid > 0 && processExists(serverPid)) {
          try { process.kill(serverPid, "SIGKILL"); } catch { /* already gone */ }
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
