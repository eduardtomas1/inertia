import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type IPty, spawn as spawnPty } from "node-pty";
import type WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import { activateRuntimeOwnedProcessRegistry } from "../../src/node/runtime-owned-processes";
import { TerminalManager } from "../../src/server/terminal";

function fakeTerminal(pid: number): IPty {
  return {
    pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  } as unknown as IPty;
}

describe("TerminalManager Darwin ownership boundary", () => {
  it("keeps provider processes strict while user shells own only their session", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-terminal-boundary-"));
    const guardianPath = "/trusted/runtime-process-guardian";
    const deactivate = activateRuntimeOwnedProcessRegistry(
      directory,
      "20000000-0000-4000-8000-000000000002:1",
      "test:10000000-0000-4000-8000-000000000001",
      { platform: "darwin", darwinGuardianPath: guardianPath },
    );
    const terminals = [fakeTerminal(100), fakeTerminal(101)];
    const spawnTerminal = vi.fn((..._args: Parameters<typeof spawnPty>) =>
      terminals[spawnTerminal.mock.calls.length - 1]!);
    const owner = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as WebSocket;
    const manager = new TerminalManager({
      platform: "darwin",
      spawnTerminal,
      spawnOwnedTerminalProcess: (spawnProcess) => ({
        process: spawnProcess(),
        confirmStopped: () => true,
        releaseIfGroupExited: () => undefined,
        requestPayloadExit: () => false,
        requestGuardianStop: () => true,
        waitForGuardianStop: async () => true,
      }),
    });

    try {
      manager.create(owner, process.cwd(), 80, 24);
      manager.createProcess(
        owner,
        process.cwd(),
        "provider-cli",
        ["resume", "session-id"],
        {},
        80,
        24,
      );

      expect(spawnTerminal.mock.calls[0]?.[0]).toBe(guardianPath);
      expect(spawnTerminal.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
        "watch-terminal-session",
      ]));
      expect(spawnTerminal.mock.calls[1]?.[0]).toBe(guardianPath);
      expect(spawnTerminal.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
        "watch",
      ]));
      expect(spawnTerminal.mock.calls[1]?.[1]).not.toContain(
        "watch-terminal-session",
      );
    } finally {
      deactivate?.();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
