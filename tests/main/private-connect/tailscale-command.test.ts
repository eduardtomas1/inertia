import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverTailscaleExecutable,
  extractTrustedServeConsentUrl,
  runTailscaleCommand,
} from "../../../src/main/private-connect/tailscale-command";

describe("Private Connect Tailscale command boundary", () => {
  it("accepts only the trusted Tailscale consent origin", () => {
    expect(extractTrustedServeConsentUrl("https://login.tailscale.com/a?b=c")).toBe("https://login.tailscale.com/a?b=c");
    expect(extractTrustedServeConsentUrl("https://evil.example/?next=https://login.tailscale.com/a")).toBeNull();
    expect(extractTrustedServeConsentUrl("not a URL")).toBeNull();
  });

  it("discovers an executable without invoking a shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-tailscale-command-"));
    const executable = join(directory, "tailscale");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);
    expect(await discoverTailscaleExecutable("linux", { PATH: directory })).toBe(executable);
  });

  it("ignores relative PATH entries when discovering Tailscale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-tailscale-relative-"));
    try {
      const executable = join(directory, "tailscale");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(executable, 0o755);
      const relativeDirectory = relative(process.cwd(), directory);
      expect(await discoverTailscaleExecutable("linux", {
        PATH: `${relativeDirectory}${delimiter}${directory}`,
      })).toBe(executable);
      expect(await discoverTailscaleExecutable("linux", {
        PATH: relativeDirectory,
      })).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds arguments and child output", async () => {
    const result = await runTailscaleCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 2_000 });
    expect(result.stdout).toBe("ok");
    await expect(runTailscaleCommand(process.execPath, ["-e", "process.stderr.write('not running'); process.exit(1)"], { timeoutMs: 2_000 })).rejects.toMatchObject({ classification: "not-running" });
    await expect(runTailscaleCommand(process.execPath, Array.from({ length: 13 }, () => "x"))).rejects.toThrow("out of bounds");
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
