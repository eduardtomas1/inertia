import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { ClaudeLaunchFileSystem } from "../../src/server/provider/claude-launch-target";
import { createClaudeOwnedQueryProcess } from "../../src/server/provider/claude-owned-query";

const NPM = "C:\\Users\\Calm Dev\\AppData\\Roaming\\npm";
const ENTRY = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const MANAGED_SETTINGS = "{\"disableAllHooks\":true,\"allowedMcpServers\":[]}";

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

function npmShimFileSystem(withNode: boolean): ClaudeLaunchFileSystem {
  const files = new Map<string, string>([
    [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\package.json`, JSON.stringify({
      name: "@anthropic-ai/claude-code",
      bin: { claude: "cli.js" },
    })],
    [ENTRY, "entry"],
    ...(withNode ? [[`${NPM}\\node.exe`, "node"] as const] : []),
  ].map(([path, value]) => [path.toLowerCase(), value]));
  return {
    readFile: (path) => Buffer.from(files.get(win32.normalize(path).toLowerCase()) ?? ""),
    realpath: (path) => win32.normalize(path),
    fileSize: (path) => {
      const value = files.get(win32.normalize(path).toLowerCase());
      return value === undefined ? null : value.length;
    },
  };
}

function spawnFor(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
  fileSystem?: ClaudeLaunchFileSystem,
) {
  const spawnProcess = vi.fn((
    _command: string,
    _args: readonly string[],
    _options: { shell?: boolean; windowsVerbatimArguments?: boolean },
  ) => fakeChild());
  const owned = createClaudeOwnedQueryProcess("Claude invocation fixture", {
    spawnProcess: spawnProcess as unknown as typeof spawn,
    platform,
    ...(fileSystem ? { launchTarget: { fileSystem } } : {}),
  });
  const spawned = () => owned.spawnClaudeCodeProcess({
    command,
    args,
    cwd: process.cwd(),
    env: { PATH: "C:\\Windows\\System32" },
    signal: new AbortController().signal,
  });
  return { spawnProcess, spawned };
}

describe("Claude owned query invocation", () => {
  it.each(["claude.cmd", "claude.BAT"])("runs the npm package entry of a Windows %s shim with node and no shell", (shim) => {
    const { spawnProcess, spawned } = spawnFor(
      "win32",
      `${NPM}\\${shim}`,
      ["--output-format", "stream-json", "--managed-settings", MANAGED_SETTINGS],
      npmShimFileSystem(true),
    );

    spawned();

    expect(spawnProcess).toHaveBeenCalledExactlyOnceWith(
      `${NPM}\\node.exe`,
      [ENTRY, "--output-format", "stream-json", "--managed-settings", MANAGED_SETTINGS],
      expect.objectContaining({ shell: false }),
    );
    expect(spawnProcess.mock.calls[0]?.[2]?.windowsVerbatimArguments).toBeFalsy();
  });

  it("refuses an npm shim it cannot run without a Node.js runtime, before spawning", () => {
    const { spawnProcess, spawned } = spawnFor(
      "win32",
      `${NPM}\\claude.cmd`,
      ["--managed-settings", MANAGED_SETTINGS],
      npmShimFileSystem(false),
    );

    expect(spawned).toThrow("no Node.js runtime was found");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["win32", "C:\\Program Files\\Claude\\claude.exe"],
    ["linux", "/usr/local/bin/claude"],
    ["darwin", "/opt/homebrew/bin/claude"],
  ] as const)("launches a %s native executable directly", (platform, command) => {
    const { spawnProcess, spawned } = spawnFor(
      platform,
      command,
      ["--managed-settings", MANAGED_SETTINGS],
    );

    spawned();

    expect(spawnProcess).toHaveBeenCalledExactlyOnceWith(
      command,
      ["--managed-settings", MANAGED_SETTINGS],
      expect.objectContaining({ shell: false }),
    );
    expect(spawnProcess.mock.calls[0]?.[2]?.windowsVerbatimArguments).toBeFalsy();
  });
});
