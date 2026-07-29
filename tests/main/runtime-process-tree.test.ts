import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  forceKillRuntimeProcessTree,
  runtimeDescendantPids,
} from "../../src/main/runtime-process-tree";

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not exit.`);
}

describe("runtime process-tree termination", () => {
  it("orders nested descendants before their parents", () => {
    expect(runtimeDescendantPids(100, [
      "100 1",
      "101 100",
      "102 101",
      "103 100",
      "900 1",
    ].join("\n"))).toEqual([102, 101, 103]);
  });

  it("freezes and kills every discovered POSIX descendant", () => {
    const kill = vi.fn();
    const spawnProcessSync = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: "100 1\n101 100\n102 101\n",
      stderr: "",
      status: 0,
      signal: null,
      error: undefined,
    }));
    forceKillRuntimeProcessTree(100, {
      platform: "linux",
      kill,
      spawnProcessSync: spawnProcessSync as never,
    });

    expect(spawnProcessSync).toHaveBeenCalledWith(
      "/bin/ps",
      ["-axo", "pid=,ppid="],
      expect.objectContaining({
        maxBuffer: 2 * 1024 * 1024,
        shell: false,
        timeout: 250,
      }),
    );
    expect(kill.mock.calls).toEqual([
      [100, "SIGSTOP"],
      [-101, "SIGSTOP"],
      [101, "SIGSTOP"],
      [-102, "SIGSTOP"],
      [102, "SIGSTOP"],
      [-102, "SIGKILL"],
      [102, "SIGKILL"],
      [-101, "SIGKILL"],
      [101, "SIGKILL"],
      [100, "SIGKILL"],
    ]);
  });

  it("freezes descendants discovered during the POSIX snapshot race", () => {
    const kill = vi.fn();
    const tables = [
      "100 1\n101 100\n",
      "100 1\n101 100\n102 101\n",
      "100 1\n101 100\n102 101\n",
    ];
    const spawnProcessSync = vi.fn(() => ({
      stdout: tables.shift() ?? "",
      status: 0,
    }));

    forceKillRuntimeProcessTree(100, {
      platform: "darwin",
      kill,
      spawnProcessSync: spawnProcessSync as never,
    });

    expect(spawnProcessSync).toHaveBeenCalledTimes(3);
    expect(kill.mock.calls).toContainEqual([-102, "SIGSTOP"]);
    expect(kill.mock.calls).toContainEqual([102, "SIGKILL"]);
    expect(kill.mock.calls.at(-1)).toEqual([100, "SIGKILL"]);
  });

  it("waits boundedly for Windows tree termination", () => {
    const spawnProcessSync = vi.fn(() => ({
      status: 0,
      error: undefined,
    }));
    const kill = vi.fn();

    forceKillRuntimeProcessTree(100, {
      platform: "win32",
      kill,
      spawnProcessSync: spawnProcessSync as never,
    });

    expect(spawnProcessSync).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/pid", "100", "/t", "/f"],
      {
        timeout: 2_000,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to a direct Windows kill when taskkill fails", () => {
    const kill = vi.fn();

    forceKillRuntimeProcessTree(100, {
      platform: "win32",
      kill,
      spawnProcessSync: vi.fn(() => ({
        status: 1,
        error: new Error("taskkill failed"),
      })) as never,
    });

    expect(kill).toHaveBeenCalledWith(100, "SIGKILL");
  });

  it.skipIf(process.platform === "win32")(
    "force-stops a real utility-shaped process and its detached provider descendant",
    async () => {
      const parent = spawn(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'],",
            "  { detached: true, stdio: 'ignore' });",
            "process.stdout.write(String(child.pid) + '\\n');",
            "setInterval(() => undefined, 1000);",
          ].join("\n"),
        ],
        {
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const chunks: Buffer[] = [];
      parent.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      while (!Buffer.concat(chunks).toString("utf8").includes("\n")) {
        await Promise.race([
          once(parent.stdout, "data"),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("Detached child PID was not reported.")),
            5_000,
          )),
        ]);
      }
      const descendantPid = Number(
        Buffer.concat(chunks).toString("utf8").trim(),
      );
      expect(descendantPid).toBeGreaterThan(1);
      try {
        forceKillRuntimeProcessTree(parent.pid!);
        await Promise.all([
          waitForProcessExit(parent.pid!),
          waitForProcessExit(descendantPid),
        ]);
      } finally {
        try { process.kill(parent.pid!, "SIGKILL"); } catch { /* Gone. */ }
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* Gone. */ }
      }
    },
    10_000,
  );
});
