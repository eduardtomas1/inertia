import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  activateRuntimeOwnedProcessRegistry,
  RuntimeOwnedProcessJournal,
} from "../../src/node/runtime-owned-processes";
import { withCodexControlClient } from "../../src/server/codex/control-client";
import { TerminalManager } from "../../src/server/terminal";

const systemBootId = "test:30000000-0000-4000-8000-000000000003";
const runtimeGenerationId = "40000000-0000-4000-8000-000000000004:1";
const temporaryDirectories: string[] = [];
const deactivators: Array<() => void> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-owned-integration-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function activate(directory: string): void {
  const deactivate = activateRuntimeOwnedProcessRegistry(
    directory,
    runtimeGenerationId,
    systemBootId,
  );
  if (deactivate) deactivators.push(deactivate);
}

afterEach(() => {
  while (deactivators.length > 0) deactivators.pop()?.();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "runtime-owned process integrations",
  () => {
    it("registers and retires a real Codex control process", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const journal = new RuntimeOwnedProcessJournal(directory);
      const responder = [
        "let buffered = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  buffered += chunk;",
        "  for (;;) {",
        "    const newline = buffered.indexOf('\\n');",
        "    if (newline < 0) break;",
        "    const line = buffered.slice(0, newline);",
        "    buffered = buffered.slice(newline + 1);",
        "    const request = JSON.parse(line);",
        "    if (request.id !== undefined) process.stdout.write(JSON.stringify({",
        "      id: request.id,",
        "      result: { method: request.method },",
        "    }) + '\\n');",
        "  }",
        "});",
        "setInterval(() => undefined, 1000);",
      ].join("\n");
      const spawnProcess = ((_command: string, _args: readonly string[], options: object) =>
        spawn(process.execPath, ["-e", responder], options)) as typeof spawn;

      await expect(withCodexControlClient({
        executable: "/ignored/codex",
        environment: process.env,
        cwd: directory,
        spawnProcess,
      }, async ({ request }) => await request("thread/list")))
        .resolves.toEqual({ method: "thread/list" });

      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
    });

    it("registers and retires a real terminal process group", async () => {
      const directory = temporaryDirectory();
      activate(directory);
      const journal = new RuntimeOwnedProcessJournal(directory);
      const manager = new TerminalManager();
      const terminalId = manager.createProcess(
        {} as WebSocket,
        directory,
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
        process.env,
        80,
        24,
      );

      expect(journal.records(runtimeGenerationId)).toMatchObject([{
        state: "owned",
        process: { processGroupId: expect.any(Number) },
      }]);
      await expect(manager.closeManaged(terminalId)).resolves.toBe(true);
      expect(journal.records(runtimeGenerationId)).toEqual([]);
      expect(journal.finishSession(runtimeGenerationId)).toBe(true);
    }, 10_000);
  },
);
