import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createClaudeOwnedQueryProcess } from "../../src/server/provider/claude-owned-query";

function fakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 4242,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function spawnFor(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
) {
  const spawnProcess = vi.fn(() => fakeChild());
  const owned = createClaudeOwnedQueryProcess("Claude invocation fixture", {
    spawnProcess: spawnProcess as unknown as typeof spawn,
    platform,
  });
  const spawned = () => owned.spawnClaudeCodeProcess({
    command,
    args,
    cwd: process.cwd(),
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    signal: new AbortController().signal,
  });
  return { spawnProcess, spawned };
}

describe("Claude owned query invocation", () => {
  it.each([
    ["cmd", "C:\\Users\\Calm Dev\\AppData\\Roaming\\npm\\claude.cmd"],
    ["bat", "C:\\Users\\Calm Dev\\Tools\\claude.BAT"],
  ])("launches a Windows .%s shim through the hardened cmd.exe invocation", (_extension, command) => {
    const { spawnProcess, spawned } = spawnFor(
      "win32",
      command,
      ["--output-format", "stream-json"],
    );

    spawned();

    const escaped = command.replaceAll(" ", "^ ");
    expect(spawnProcess).toHaveBeenCalledExactlyOnceWith(
      "C:\\Windows\\System32\\cmd.exe",
      [
        "/d",
        "/s",
        "/v:off",
        "/c",
        `"${escaped} ^"--output-format^" ^"stream-json^""`,
      ],
      expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
    );
  });

  it.each([
    ["win32", "C:\\Program Files\\Claude\\claude.exe"],
    ["linux", "/usr/local/bin/claude"],
    ["darwin", "/opt/homebrew/bin/claude"],
  ] as const)("launches a %s native executable directly", (platform, command) => {
    const { spawnProcess, spawned } = spawnFor(
      platform,
      command,
      ["--output-format", "stream-json"],
    );

    spawned();

    expect(spawnProcess).toHaveBeenCalledExactlyOnceWith(
      command,
      ["--output-format", "stream-json"],
      expect.objectContaining({ shell: false }),
    );
    expect(spawnProcess.mock.calls[0]?.[2]?.windowsVerbatimArguments).toBeFalsy();
  });

  it("refuses a Windows shim argument that cmd.exe cannot carry safely", () => {
    const { spawnProcess, spawned } = spawnFor(
      "win32",
      "C:\\Users\\Calm Dev\\AppData\\Roaming\\npm\\claude.cmd",
      ["--managed-settings", "{\"disableAllHooks\":true}"],
    );

    expect(spawned).toThrow("cannot be passed safely to a Windows command shim");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
