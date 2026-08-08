import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  discoverTailscaleExecutable,
  extractTrustedServeConsentUrl,
  runTailscaleCommand,
} from "../../../src/main/private-connect/tailscale-command";

const hostPlatform = process.platform;
const hostExecutableName = hostPlatform === "win32" ? "tailscale.exe" : "tailscale";

async function writeDiscoverableExecutable(directory: string): Promise<string> {
  const executable = join(directory, hostExecutableName);
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (hostPlatform !== "win32") await chmod(executable, 0o755);
  return executable;
}

describe("Private Connect Tailscale command boundary", () => {
  it("accepts only the trusted Tailscale consent origin", () => {
    expect(extractTrustedServeConsentUrl("https://login.tailscale.com/a?b=c")).toBe("https://login.tailscale.com/a?b=c");
    expect(extractTrustedServeConsentUrl("https://evil.example/?next=https://login.tailscale.com/a")).toBeNull();
    expect(extractTrustedServeConsentUrl("not a URL")).toBeNull();
  });

  it("discovers an executable in a spaced directory without invoking a shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia tailscale command "));
    try {
      const executable = await writeDiscoverableExecutable(directory);
      expect(await discoverTailscaleExecutable(hostPlatform, { PATH: directory })).toBe(executable);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores relative PATH entries when discovering Tailscale", async () => {
    const directory = await mkdtemp(join(process.cwd(), "inertia-tailscale-relative-"));
    try {
      const executable = await writeDiscoverableExecutable(directory);
      const relativeDirectory = relative(process.cwd(), directory);
      expect(isAbsolute(relativeDirectory)).toBe(false);
      expect(await discoverTailscaleExecutable(hostPlatform, {
        PATH: `${relativeDirectory}${delimiter}${directory}`,
      })).toBe(executable);
      expect(await discoverTailscaleExecutable(hostPlatform, {
        PATH: relativeDirectory,
      })).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never resolves a relative PATH entry for any target platform", async () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const separator = platform === "win32" ? ";" : ":";
      const found = await discoverTailscaleExecutable(platform, {
        PATH: [".", "bin", "..", ""].join(separator),
      });
      expect(found === null || isAbsolute(found)).toBe(true);
    }
  });

  it("bounds arguments and child output", async () => {
    const result = await runTailscaleCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 2_000 });
    expect(result.stdout).toBe("ok");
    await expect(runTailscaleCommand(process.execPath, ["-e", "process.stderr.write('not running'); process.exit(1)"], { timeoutMs: 2_000 })).rejects.toMatchObject({ classification: "not-running" });
    await expect(runTailscaleCommand(process.execPath, Array.from({ length: 13 }, () => "x"))).rejects.toThrow("out of bounds");
  });

  it("waits for stdio close before returning complete command output", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr }) as unknown as ChildProcess;
    const resultPromise = runTailscaleCommand("tailscale", ["status"], {
      timeoutMs: 2_000,
      spawnProcess: () => child,
    });
    stdout.write("status-");
    child.emit("exit", 0, null);
    let settled = false;
    void resultPromise.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    stdout.write("complete");
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({ stdout: "status-complete", code: 0 });
  });

  it("uses a stable locale and confirms detached process-tree termination on timeout", async () => {
    const locale = await runTailscaleCommand(process.execPath, ["-e", "process.stdout.write(process.env.LC_ALL ?? '')"], { timeoutMs: 2_000 });
    expect(locale.stdout).toBe("C");
    await expect(runTailscaleCommand(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { timeoutMs: 500 })).rejects.toMatchObject({ classification: "command-timeout" });
  });

  it("terminates the child tree when output exceeds the bound", async () => {
    await expect(runTailscaleCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { timeoutMs: 2_000, outputBytes: 1_024 })).rejects.toThrow(/output exceeded|cleanup could not be confirmed/u);
  });
});
