import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { sampleUnexitedElectronMain } from "../e2e/support/electron-unexited-main-sample";

function sampler(behaviour: "writes" | "empty" | "hangs" | "missing") {
  const kill = vi.fn();
  const calls: { command: string; args: string[] }[] = [];
  const run = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    const tool = Object.assign(new EventEmitter(), { kill });
    queueMicrotask(() => {
      if (behaviour === "missing") { tool.emit("error", new Error("ENOENT")); return; }
      if (behaviour === "hangs") return;
      writeFileSync(args.at(-1)!, behaviour === "writes" ? "Call graph:\n  main thread\n" : "");
      tool.emit("exit", 0, null);
    });
    return tool;
  });
  return { spawn: run as unknown as typeof spawn, kill, calls };
}

describe("sample of an Electron main process that outlived its quit deadline", () => {
  it("writes one whole sample of the main process to a file and attaches it", async () => {
    const tool = sampler("writes");
    const attach = vi.fn(async () => undefined);
    await expect(sampleUnexitedElectronMain(4_321, { platform: "darwin", spawn: tool.spawn, attach }))
      .resolves.toBe("attached");
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]!.command).toBe("/usr/bin/sample");
    expect(tool.calls[0]!.args.slice(0, 4)).toEqual(["4321", "3", "-mayDie", "-file"]);
    expect(attach).toHaveBeenCalledExactlyOnceWith(tool.calls[0]!.args[4]);
    expect(tool.kill).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("does nothing on %s", async (platform) => {
    const tool = sampler("writes");
    await expect(sampleUnexitedElectronMain(4_321, { platform, spawn: tool.spawn })).resolves.toBe("skipped");
    expect(tool.calls).toEqual([]);
  });

  it.each([null, undefined, 0, 1, process.pid, 1.5])("does not sample the pid %s", async (pid) => {
    const tool = sampler("writes");
    await expect(sampleUnexitedElectronMain(pid, { platform: "darwin", spawn: tool.spawn })).resolves.toBe("skipped");
    expect(tool.calls).toEqual([]);
  });

  it("stops a sampler that does not finish within its bound and reports nothing", async () => {
    const tool = sampler("hangs");
    const attach = vi.fn(async () => undefined);
    await expect(sampleUnexitedElectronMain(4_321, { platform: "darwin", spawn: tool.spawn, attach, boundMs: 20 }))
      .resolves.toBe("unavailable");
    expect(tool.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(attach).not.toHaveBeenCalled();
  });

  it.each(["empty", "missing"] as const)("never fails the close when the sampler is %s", async (behaviour) => {
    const tool = sampler(behaviour);
    const attach = vi.fn(async () => undefined);
    await expect(sampleUnexitedElectronMain(4_321, { platform: "darwin", spawn: tool.spawn, attach }))
      .resolves.toBe("unavailable");
    expect(attach).not.toHaveBeenCalled();
  });

  it("never fails the close when the report cannot be attached", async () => {
    const tool = sampler("writes");
    await expect(sampleUnexitedElectronMain(4_321, {
      platform: "darwin", spawn: tool.spawn, attach: async () => { throw new Error("no test is running"); },
    })).resolves.toBe("unavailable");
  });
});
