// @inertia-test-suite portable
import { expect, it, vi } from "vitest";

import { withCodexControlClient } from "../../src/server/codex/control-client";
import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { readClaudeAgentSdkSkills } from "../../src/server/provider/claude-skill-query";
import { detectProvider, ProviderManager, type CodexControlContext } from "../../src/server/providers";
import { portableFixtureRoot, removePortableFixture, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

// Skill enumeration is downstream of the discovery behavior under test. Never
// consult real user skill directories or launch the actual Claude SDK here.
vi.mock("../../src/server/provider/claude-skill-query", () => ({
  readClaudeAgentSdkSkills: vi.fn(async () => []),
}));

const scenarios = (["control", "metadata", "skills"] as const)
  .flatMap((operation) => [false, true].map((late) => ({ operation, late })));

it.each(scenarios)("keeps cold $operation discovery in its workspace (late detection: $late)", async ({ operation, late }) => {
  const providerId = operation === "skills" ? "claude" : "codex";
  const root = portableFixtureRoot("provider cold discovery context");
  // The same real Node/subcommand transport as the Electron bridge fixture.
  // No actual provider executable, account, or model is involved.
  writeNodeSubcommand(root, "app-server", `
    if (process.argv[2] === "--help") {
      process.stdout.write("Usage: codex app-server [OPTIONS]\\n");
      process.exit(0);
    }
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = message.method === "initialize" ? { userAgent: "context-fixture" }
        : message.method === "model/list" ? { data: [], nextCursor: null }
        : message.method === "account/rateLimits/read" ? { rateLimits: null }
        : { goal: null };
      process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
    });
  `);
  writeNodeSubcommand(root, "login", 'process.stdout.write("Logged in using ChatGPT\\n");');
  writeNodeSubcommand(root, "auth", 'process.stdout.write(JSON.stringify({ loggedIn: true }));');
  const leases = new ProviderInstallationLeaseCoordinator();
  const metadataCache = new ProviderMetadataCache();
  let releaseCold!: () => void;
  let announceCold!: () => void;
  const coldStarted = new Promise<void>((resolve) => { announceCold = resolve; });
  const coldGate = new Promise<void>((resolve) => { releaseCold = resolve; });
  let detections = 0;
  const manager = ProviderManager.createProduction({
    commands: { [providerId]: process.execPath }, installationLeases: leases, metadataCache,
    detectProvider: async (providerId, options) => {
      detections += 1;
      if (detections === 1) {
        announceCold();
        await coldGate;
      }
      return await detectProvider(providerId, options);
    },
  });
  const input = nativeProviderRunInput({
    providerId, conversationId: "control-next-turn", cwd: root,
    prompt: "Synthetic next turn", interactionMode: "build", access: "supervised",
  });
  let context: CodexControlContext | undefined;
  const contextRequest = operation === "control" ? manager.codexControlContext(root) : undefined;
  const pending = contextRequest ?? (operation === "metadata"
    ? manager.metadata(providerId, root)
    : manager.claudeSkills(root, false));
  try {
    await coldStarted;
    if (late) {
      // Reproduce startup discovery finishing before a saved session's slower
      // cold goal/control lookup. The latter must not erase valid evidence by
      // probing app-server/login from the unrelated application cwd.
      await expect(manager.detect(providerId, { cwd: root })).resolves.toMatchObject({
        canRun: true, protocolVerified: true, cleanupConfirmed: true,
      });
      expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);
    }
    releaseCold();
    await pending;
    context = await contextRequest;
    expect(manager.providerCapabilityContract(providerId).installationVerified).toBe(true);
    expect(metadataCache.nativeScope(providerId).authState).toBe("authenticated");
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);
    if (context) {
      expect(context.cwd).toBe(root);
      await expect(withCodexControlClient(context, async ({ request }) =>
        await request("thread/goal/get", { threadId: "context-fixture-thread" }),
      )).resolves.toEqual({ goal: null });
    }
    if (operation === "skills") {
      expect(vi.mocked(readClaudeAgentSdkSkills).mock.lastCall?.[2]).toBe(root);
    }
    expect(leases.hasProviderAuthority(providerId)).toBe(false);
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);
  } finally {
    releaseCold();
    await pending.catch(() => undefined);
    context ??= await contextRequest?.catch(() => undefined);
    context?.installationUse.abandonBeforeSpawn();
    await manager.disposeAll();
    await removePortableFixture(root);
  }
});
