// @inertia-test-suite portable
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectProvider, ProviderManager } from "../../src/server/providers";
import {
  OPENCODE_VERSION_CEILING,
  PROVIDER_VERSION_FLOORS,
  providerVersionBelowFloor,
  providerVersionFloorMessage,
} from "../../src/server/provider/provider-version-floors";
import { providerSnapshot } from "../../src/server/runtime-snapshots";
import { defaultSettings } from "../../src/shared/contracts";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import {
  portableFixtureRoot,
  removePortableFixture,
  writeNodeClaudeExecutable,
  writeNodeFlagExecutable,
} from "../helpers/portable-provider-fixture";

const CLAUDE_BELOW_FLOOR_MESSAGE =
  "Claude Code 2.1.150 is installed. Inertia needs 2.1.309 or newer because older versions ignore the restrictions Inertia sets and can write outside the project. Update Claude Code and refresh.";
const OPENCODE_BELOW_FLOOR_MESSAGE =
  "OpenCode 1.18.21 is installed. Inertia needs 1.18.22 or newer because older versions let a website install packages through OpenCode's local server. Update OpenCode and refresh.";

describe("provider version floors", { concurrent: false }, () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function executable(name: string): string {
    const root = portableFixtureRoot(`version floor ${name}`);
    roots.push(root);
    return join(root, name);
  }

  it("records each floor with the reason it exists", () => {
    expect(PROVIDER_VERSION_FLOORS.claude).toMatchObject({
      product: "Claude Code",
      minimumVersion: "2.1.309",
    });
    expect(PROVIDER_VERSION_FLOORS.opencode).toMatchObject({
      product: "OpenCode",
      minimumVersion: "1.18.22",
    });
    expect(PROVIDER_VERSION_FLOORS.antigravity).toMatchObject({
      product: "Antigravity",
      minimumVersion: "1.2.2",
    });
    expect(OPENCODE_VERSION_CEILING.firstUnsupportedMajor).toBe(2);
    for (const floor of Object.values(PROVIDER_VERSION_FLOORS)) {
      expect(floor.reason.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["2.1.308", "2.1.309", true],
    ["2.1.309", "2.1.309", false],
    ["2.1.310", "2.1.309", false],
    ["2.0.999", "2.1.309", true],
    ["3.0.0", "2.1.309", false],
    ["v2.1.308", "2.1.309", true],
    ["v2.1.309", "2.1.309", false],
    ["2.2", "2.1.309", false],
    ["2.1", "2.1.309", true],
    ["2.1.309-beta.1", "2.1.309", true],
    ["2.1.310-beta.1", "2.1.309", false],
    ["2.1.308+build.7", "2.1.309", true],
    ["2.1.309+build.7", "2.1.309", false],
    ["1.18.21", "1.18.22", true],
    ["1.18.22", "1.18.22", false],
    ["1.19.3", "1.18.22", false],
    ["1.9.30", "1.18.22", true],
    ["0.0.0", "1.18.22", true],
  ] as const)("treats %s against the %s floor as below it: %s", (version, minimumVersion, below) => {
    expect(providerVersionBelowFloor(version, minimumVersion)).toBe(below);
  });

  it.each([
    undefined,
    "",
    "local",
    "unknown",
    "2",
    "2.1.x",
    "0.0.0-dev-202610261200",
    "0.0.0-snapshot",
    "v0.0.0-main.4f1c2a9",
  ])(
    "never blocks a version it cannot parse: %s",
    (version) => {
      expect(providerVersionBelowFloor(version, "2.1.309")).toBe(false);
      expect(providerVersionBelowFloor(version, "1.18.22")).toBe(false);
    },
  );

  it("explains the floor in plain words with both versions and the fix", () => {
    expect(providerVersionFloorMessage(PROVIDER_VERSION_FLOORS.claude, "2.1.150"))
      .toBe(CLAUDE_BELOW_FLOOR_MESSAGE);
    expect(providerVersionFloorMessage(PROVIDER_VERSION_FLOORS.opencode, "1.18.21"))
      .toBe(OPENCODE_BELOW_FLOOR_MESSAGE);
  });

  function claudeDetection(version: string, calls: string[][] = []) {
    const command = executable("claude");
    return detectProvider("claude", { command }, {
      executableCandidates: async () => [command],
      now: () => 0,
      probeProcess: async (_candidate, args) => {
        calls.push([...args]);
        return {
          started: true,
          timedOut: false,
          cleanupConfirmed: true,
          exitCode: 0,
          output: args[0] === "--version" ? version : '{"loggedIn":true,"authMethod":"claude.ai"}',
        };
      },
    }).then((detection) => ({ command, detection }));
  }

  it("refuses Claude Code below its floor without checking sign-in", async () => {
    const calls: string[][] = [];
    const { command, detection } = await claudeDetection("2.1.150 (Claude Code)", calls);
    expect(detection).toMatchObject({
      available: true,
      executable: command,
      version: "2.1.150",
      installState: "installed",
      authState: "unknown",
      canRun: false,
      cleanupConfirmed: true,
      updateRequired: { installedVersion: "2.1.150", minimumVersion: "2.1.309" },
      statusMessage: CLAUDE_BELOW_FLOOR_MESSAGE,
    });
    expect(calls).toEqual([["--version"]]);
  });

  it.each(["2.1.309 (Claude Code)", "2.1.320 (Claude Code)", "2.1.310-beta.1 (Claude Code)"])(
    "runs Claude Code at or above its floor: %s",
    async (output) => {
      const { detection } = await claudeDetection(output);
      expect(detection).toMatchObject({
        installState: "installed",
        authState: "authenticated",
        canRun: true,
        statusMessage: "Connected",
      });
      expect(detection).not.toHaveProperty("updateRequired");
    },
  );

  it.each(["2.1.179 (Claude Code)", "2.1.308 (Claude Code)"])(
    "refuses Claude Code that has the earlier fixes but drops Inertia's managed settings: %s",
    async (output) => {
      const { detection } = await claudeDetection(output);
      expect(detection).toMatchObject({
        canRun: false,
        updateRequired: { minimumVersion: "2.1.309" },
      });
    },
  );

  it("refuses a Claude Code prerelease of the floor version itself", async () => {
    const { detection } = await claudeDetection("2.1.309-beta.1 (Claude Code)");
    expect(detection).toMatchObject({
      canRun: false,
      version: "2.1.309-beta.1",
      updateRequired: { installedVersion: "2.1.309-beta.1", minimumVersion: "2.1.309" },
    });
  });

  it("keeps today's behaviour when the Claude Code version cannot be parsed", async () => {
    const { detection } = await claudeDetection("Claude Code (development build)");
    expect(detection).not.toHaveProperty("updateRequired");
    expect(detection.statusMessage).not.toContain("Inertia needs");
  });

  it("selects a Claude Code at its floor over an older one on the same PATH", async () => {
    const older = executable("claude");
    const current = executable("claude");
    const detection = await detectProvider("claude", { command: "claude" }, {
      executableCandidates: async () => [older, current],
      now: () => 0,
      probeProcess: async (candidate, args) => ({
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
        exitCode: 0,
        output: args[0] === "--version"
          ? candidate === older ? "2.1.150 (Claude Code)" : "2.1.309 (Claude Code)"
          : '{"loggedIn":true}',
      }),
    });
    expect(detection).toMatchObject({ executable: current, version: "2.1.309", canRun: true });
  });

  function openCodeDetection(version: string, calls: string[][] = []) {
    const command = executable("opencode");
    let isolationProofs = 0;
    return detectProvider("opencode", { command }, {
      executableCandidates: async () => [command],
      probeOpenCodePureIsolation: async () => {
        isolationProofs += 1;
        return { cleanupConfirmed: true, outcome: "verified" };
      },
      probeProcess: async (_candidate, args) => {
        calls.push([...args]);
        return {
          started: true,
          timedOut: false,
          cleanupConfirmed: true,
          exitCode: 0,
          output: args[0] === "--version" ? version
            : args[0] === "serve" ? "--pure run without external plugins"
              : "Credentials\n1 credentials",
        };
      },
    }).then((detection) => ({ command, detection, isolationProofs: () => isolationProofs }));
  }

  it("refuses OpenCode below its floor without starting its server or checking sign-in", async () => {
    const calls: string[][] = [];
    const { command, detection, isolationProofs } = await openCodeDetection("1.18.21", calls);
    expect(detection).toMatchObject({
      available: true,
      executable: command,
      version: "1.18.21",
      installState: "installed",
      authState: "unknown",
      canRun: false,
      cleanupConfirmed: true,
      updateRequired: { installedVersion: "1.18.21", minimumVersion: "1.18.22" },
      statusMessage: OPENCODE_BELOW_FLOOR_MESSAGE,
    });
    expect(isolationProofs()).toBe(0);
    expect(calls).toEqual([["--version"]]);
  });

  function noisyDetection(providerId: "claude" | "opencode", stdout: string, stderr: string) {
    const command = executable(providerId);
    return detectProvider(providerId, { command }, {
      executableCandidates: async () => [command],
      now: () => 0,
      probeOpenCodePureIsolation: async () => ({ cleanupConfirmed: true, outcome: "verified" }),
      probeProcess: async (_candidate, args) => ({
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
        exitCode: 0,
        ...(args[0] === "--version"
          ? { output: `${stderr}${stdout}`, stdout }
          : { output: args[0] === "serve" ? "--pure run without external plugins" : '{"loggedIn":true}' }),
      }),
    });
  }

  it("reads the Claude Code version from its own line, not from a warning printed before it", async () => {
    const detection = await noisyDetection("claude", "2.1.100 (Claude Code)\n", "(node:4242) Warning v22.1.0 is deprecated\n");
    expect(detection).toMatchObject({
      version: "2.1.100",
      canRun: false,
      updateRequired: { installedVersion: "2.1.100", minimumVersion: "2.1.309" },
    });
  });

  it("reads the Claude Code version from its own line when stdout carries a warning too", async () => {
    const detection = await noisyDetection("claude", "Warning: Node v22.1.0 is unsupported\n2.1.100 (Claude Code)\n", "");
    expect(detection).toMatchObject({ version: "2.1.100", updateRequired: { installedVersion: "2.1.100" } });
  });

  it("reads the OpenCode version from its own line, not from a warning printed before it", async () => {
    const detection = await noisyDetection("opencode", "Warning: Node v22.1.0 is unsupported\n1.18.21\n", "(node:4242) Warning v22.1.0\n");
    expect(detection).toMatchObject({
      version: "1.18.21",
      canRun: false,
      updateRequired: { installedVersion: "1.18.21", minimumVersion: "1.18.22" },
    });
  });

  it.each(["1.18.22", "opencode 1.18.26", "1.19.3 (abc123)"])(
    "runs OpenCode at or above its floor: %s",
    async (output) => {
      const { detection, isolationProofs } = await openCodeDetection(output);
      expect(detection).toMatchObject({
        installState: "installed",
        authState: "configured",
        canRun: true,
      });
      expect(detection).not.toHaveProperty("updateRequired");
      expect(isolationProofs()).toBe(1);
    },
  );

  it("keeps the OpenCode 2 message ahead of the floor", async () => {
    const { detection } = await openCodeDetection("2.0.22");
    expect(detection).toMatchObject({
      canRun: false,
      statusMessage: OPENCODE_VERSION_CEILING.message,
    });
    expect(detection).not.toHaveProperty("updateRequired");
  });

  it.each(["local", "0.0.0-dev-202610261200"])("keeps today's behaviour when the OpenCode version cannot be parsed: %s", async (version) => {
    const { detection } = await openCodeDetection(version);
    expect(detection).not.toHaveProperty("updateRequired");
    expect(detection.statusMessage ?? "").not.toContain("Inertia needs");
  });

  it("reports the Antigravity floor through the same update requirement", async () => {
    const command = executable("agy");
    const detection = await detectProvider("antigravity", { command }, {
      executableCandidates: async () => [command],
      probeProcess: async () => ({
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
        exitCode: 0,
        output: "1.1.0",
      }),
    });
    expect(detection).toMatchObject({
      canRun: false,
      updateRequired: { installedVersion: "1.1.0", minimumVersion: "1.2.2" },
      statusMessage: "Antigravity 1.1.0 is installed, but Inertia needs 1.2.2 or newer. Run 'agy update' and refresh.",
    });
  });

  it("reports the Antigravity floor for the newest identified install", async () => {
    const older = executable("agy");
    const newer = executable("agy");
    const detection = await detectProvider("antigravity", { command: "agy" }, {
      executableCandidates: async () => [older, newer],
      probeProcess: async (candidate) => ({
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
        exitCode: 0,
        output: candidate === older ? "1.1.0" : "1.2.1",
      }),
    });
    expect(detection).toMatchObject({
      executable: newer,
      version: "1.2.1",
      updateRequired: { installedVersion: "1.2.1", minimumVersion: "1.2.2" },
      statusMessage: "Antigravity 1.2.1 is installed, but Inertia needs 1.2.2 or newer. Run 'agy update' and refresh.",
    });
  });

  it("states every remedy as a full sentence", () => {
    for (const floor of Object.values(PROVIDER_VERSION_FLOORS)) {
      expect(floor.remedy).toMatch(/^[A-Z].*\.$/u);
    }
  });

  async function belowFloorManager(providerId: "claude" | "opencode") {
    const root = portableFixtureRoot(`version floor spawn ${providerId}`);
    roots.push(root);
    const marker = join(root, "spawned.log");
    const source = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + String.fromCharCode(10));`;
    const command = providerId === "claude"
      ? writeNodeClaudeExecutable(root, source)
      : writeNodeFlagExecutable(root, "opencode", source);
    const detection = await detectProvider(providerId, { command }, {
      executableCandidates: async () => [command],
      now: () => 0,
      probeOpenCodePureIsolation: async () => ({ cleanupConfirmed: true, outcome: "verified" }),
      probeProcess: async (_candidate, args) => ({
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
        exitCode: 0,
        output: args[0] === "--version"
          ? providerId === "claude" ? "2.1.150 (Claude Code)" : "1.18.21"
          : args[0] === "serve" ? "--pure run without external plugins" : '{"loggedIn":true}',
      }),
    });
    expect(detection.updateRequired).toBeDefined();
    const manager = ProviderManager.createForTests({
      commands: { [providerId]: command },
      detectProvider: async () => detection,
    });
    return {
      manager,
      root,
      message: providerId === "claude" ? CLAUDE_BELOW_FLOOR_MESSAGE : OPENCODE_BELOW_FLOOR_MESSAGE,
      spawned: () => existsSync(marker),
    };
  }

  it.each([
    ["claude", "skill discovery", (manager: ProviderManager, root: string) => manager.claudeSkills(root, false)],
    ["claude", "sign-in", (manager: ProviderManager, root: string) => manager.authLaunch("claude", root)],
    ["opencode", "sign-in", (manager: ProviderManager, root: string) => manager.authLaunch("opencode", root)],
    ["claude", "model discovery", (manager: ProviderManager, root: string) => manager.metadata("claude", root, { force: true })],
    ["opencode", "model discovery", (manager: ProviderManager, root: string) => manager.metadata("opencode", root, { force: true })],
    ["claude", "terminal resume", (manager: ProviderManager, root: string) => manager.terminalResumeLaunch("11111111-1111-4111-8111-111111111111", "claude", "22222222-2222-4222-8222-222222222222", root)],
    ["opencode", "terminal resume", (manager: ProviderManager, root: string) => manager.terminalResumeLaunch("11111111-1111-4111-8111-111111111111", "opencode", "ses_floor", root)],
    ["claude", "usage", async (manager: ProviderManager, root: string) => {
      await manager.detect("claude", { cwd: root });
      return await manager.claudeUsage(root);
    }],
    ["opencode", "usage", async (manager: ProviderManager, root: string) => {
      await manager.detect("opencode", { cwd: root });
      return await manager.openCodeUsageAccount(root, "opencode-go/kimi-k2", new AbortController().signal);
    }],
  ] as const)("never starts %s below its floor for %s", async (providerId, _operation, operate) => {
    const { manager, root, message, spawned } = await belowFloorManager(providerId);
    try {
      await expect(operate(manager, root)).rejects.toMatchObject({ message });
      expect(spawned()).toBe(false);
    } finally {
      await manager.disposeAll();
    }
  });

  it("carries the update requirement into the validated provider snapshot", async () => {
    const { detection } = await claudeDetection("2.1.150 (Claude Code)");
    const snapshot = providerSnapshot(detection);
    expect(snapshot).toMatchObject({
      canRun: false,
      updateRequired: { installedVersion: "2.1.150", minimumVersion: "2.1.309" },
      statusMessage: CLAUDE_BELOW_FLOOR_MESSAGE,
    });
    const event = (providers: unknown[]) => ({
      type: "snapshot.updated",
      snapshot: {
        projects: [],
        conversations: [],
        runs: [],
        providers,
        settings: defaultSettings,
        activeProjectId: null,
        activeConversationId: null,
      },
    });
    expect(serverEventSchema.safeParse(event([snapshot])).success).toBe(true);
    expect(serverEventSchema.safeParse(event([
      { ...snapshot, updateRequired: { installedVersion: 2, minimumVersion: "2.1.309" } },
    ])).success).toBe(false);
    expect(serverEventSchema.safeParse(event([
      { ...snapshot, updateRequired: { installedVersion: "v2.1.150-beta.1+build.7", minimumVersion: "2.1.309" } },
    ])).success).toBe(true);
    for (const rejected of [
      { ...snapshot, updateRequired: { installedVersion: "2.1.150", minimumVersion: "2.1.309", note: "extra" } },
      { ...snapshot, updateRequired: { installedVersion: "2.1.150" } },
      { ...snapshot, updateRequired: { installedVersion: "1".repeat(65), minimumVersion: "2.1.309" } },
      { ...snapshot, updateRequired: { installedVersion: "2.1.150 <b>", minimumVersion: "2.1.309" } },
      { ...snapshot, updateRequired: { installedVersion: "", minimumVersion: "2.1.309" } },
      { ...snapshot, canRun: true },
      { ...snapshot, installState: "error" },
    ]) {
      expect(serverEventSchema.safeParse(event([rejected])).success).toBe(false);
    }
  });
});
