import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("bounds arguments and child output", async () => {
    const result = await runTailscaleCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 2_000 });
    expect(result.stdout).toBe("ok");
    await expect(runTailscaleCommand(process.execPath, ["-e", "process.stderr.write('not running'); process.exit(1)"], { timeoutMs: 2_000 })).rejects.toMatchObject({ classification: "not-running" });
    await expect(runTailscaleCommand(process.execPath, Array.from({ length: 13 }, () => "x"))).rejects.toThrow("out of bounds");
  });
});
