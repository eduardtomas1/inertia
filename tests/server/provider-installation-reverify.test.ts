// @inertia-test-suite portable
import { chmodSync, copyFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { ProviderManager } from "../../src/server/providers";
import { providerInstallationVerifier } from "../../src/server/provider/provider-info-refresh";
import { PROVIDER_INFO } from "../../src/server/provider/catalog";
import { PROVIDER_IDS } from "../../src/server/provider/contracts";
import { portableFixtureRoot, removePortableFixture, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

it.each(PROVIDER_IDS)("blocks discovery and launch while %s has pending maintenance recovery", async (providerId) => {
  const detect = vi.fn(async (providerId: keyof typeof PROVIDER_INFO) => ({
    provider: PROVIDER_INFO[providerId], available: false,
    installState: "not-installed" as const, authState: "unknown" as const,
    canRun: false, cleanupConfirmed: true,
  }));
  const manager = ProviderManager.createProduction({
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    conversationProviderGate: () => undefined,
    providerRecoveryPending: (id) => id === providerId,
    detectProvider: detect,
  });
  try {
    await expect(manager.detect(providerId, { refreshEnvironment: true })).resolves.toMatchObject({
      installState: "recovery-required", authState: "unknown", canRun: false,
    });
    expect(detect).not.toHaveBeenCalled();
    await expect(manager.validateCommand(providerId, process.execPath)).rejects.toThrow("recovery");
    await expect(manager.authLaunch(providerId)).rejects.toThrow("recovery");
    await expect(manager.terminalResumeLaunch("chat", providerId, "session", process.cwd())).rejects.toThrow("recovery");
    await expect(manager.metadata(providerId, process.cwd(), { force: true })).rejects.toThrow("recovery");
    if (providerId === "claude") await expect(manager.claudeSkills(process.cwd(), true)).rejects.toThrow("recovery");
    const input = nativeProviderRunInput({
      providerId, conversationId: "blocked-chat", cwd: process.cwd(),
      prompt: "Synthetic turn", interactionMode: "build", access: "supervised",
    });
    expect(() => manager.run(input)).toThrow("recovery");
    expect(() => manager.compact(input)).toThrow("recovery");
    expect(detect).not.toHaveBeenCalled();
    for (const otherProvider of PROVIDER_IDS.filter((id) => id !== providerId)) {
      await expect(manager.detect(otherProvider)).resolves.toMatchObject({ installState: "not-installed" });
    }
    expect(detect.mock.calls.map(([id]) => id)).toEqual(PROVIDER_IDS.filter((id) => id !== providerId));
  } finally {
    await manager.disposeAll();
  }
});

it.each((["codex", "claude", "opencode"] as const).flatMap((providerId) =>
  [false, true].map((cached) => [providerId, cached] as const),
))("retains recovery guidance for %s usage reads (cached executable: %s)", async (providerId, cached) => {
  let recoveryPending = false;
  const detect = vi.fn(async () => ({
    provider: PROVIDER_INFO[providerId], available: true, executable: process.execPath, version: "2.0.0",
    installState: "installed" as const, authState: "authenticated" as const,
    canRun: true, protocolVerified: true, cleanupConfirmed: true,
  }));
  const manager = ProviderManager.createProduction({
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    conversationProviderGate: () => undefined,
    providerRecoveryPending: (id) => recoveryPending && id === providerId,
    detectProvider: detect,
  });
  try {
    if (cached) await manager.detect(providerId);
    recoveryPending = true;
    detect.mockClear();
    const read = providerId === "codex" ? manager.codexControlContext(process.cwd())
      : providerId === "claude" ? manager.claudeUsage(process.cwd())
      : manager.openCodeUsageAccount(process.cwd(), "opencode-go/fixture", new AbortController().signal);
    await expect(read).rejects.toThrow("recovery");
    expect(detect).not.toHaveBeenCalled();
  } finally {
    await manager.disposeAll();
  }
});

function writeCodexLauncher(path: string): void {
  const staged = `${path}.next`;
  // Replace the provider launcher, not the Node executable used to run the
  // fixture. A closed Windows child can still retain its executable image;
  // installation fingerprinting must not depend on immediate PE replacement.
  if (process.platform === "win32") {
    writeFileSync(staged, `@echo off\r\n"${process.execPath}" %*\r\n`, "utf8");
  } else {
    writeFileSync(staged, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, "utf8");
    chmodSync(staged, 0o755);
  }
  renameSync(staged, path);
}

it("re-verifies Codex after its executable is replaced while Inertia runs", async () => {
  const root = portableFixtureRoot("provider installation reverify");
  writeNodeSubcommand(root, "app-server", `
    if (process.argv[2] === "--help") {
      process.stdout.write("Usage: codex app-server [OPTIONS]\\n");
      process.exit(0);
    }
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      const result = message.method === "initialize" ? { userAgent: "reverify-fixture" }
        : message.method === "model/list" ? { data: [], nextCursor: null }
        : message.method === "account/rateLimits/read" ? { rateLimits: null }
        : { goal: null };
      process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
    });
  `);
  writeNodeSubcommand(root, "login", 'process.stdout.write("Logged in using ChatGPT\\n");');
  const executable = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  writeCodexLauncher(executable);
  const manager = ProviderManager.createProduction({
    commands: { codex: executable },
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    conversationProviderGate: () => undefined,
    metadataCache: new ProviderMetadataCache(),
  });
  const input = nativeProviderRunInput({
    providerId: "codex", conversationId: "reverify-after-update", cwd: root,
    prompt: "Synthetic turn", interactionMode: "build", access: "supervised",
  });
  try {
    expect(manager.providerInstallationState("codex")).toBe("unverified");
    expect(() => manager.run(input)).toThrow(
      "Inertia has not verified this Codex installation yet. Open Settings > Agents and choose Refresh all providers, or restart Inertia.",
    );
    await expect(manager.detect("codex", { cwd: root })).resolves.toMatchObject({
      canRun: true, protocolVerified: true, cleanupConfirmed: true,
    });
    expect(manager.providerInstallationState("codex")).toBe("current");
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);

    writeCodexLauncher(executable);

    expect(manager.providerInstallationState("codex")).toBe("changed");
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(false);
    expect(() => manager.run(input)).toThrow(
      "Codex changed since Inertia last checked it, for example after an update, and Inertia could not verify the new installation. Open Settings > Agents and choose Refresh all providers, or restart Inertia.",
    );

    await expect(manager.detect("codex", { cwd: root })).resolves.toMatchObject({
      canRun: true, protocolVerified: true, cleanupConfirmed: true,
    });
    expect(manager.providerInstallationState("codex")).toBe("current");
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);

    // A second update that fails its real protocol probe must stay refused.
    writeNodeSubcommand(root, "app-server", "process.exit(1);");
    writeCodexLauncher(executable);
    await providerInstallationVerifier(manager, async (providerId, refreshEnvironment) => {
      await manager.detect(providerId!, { cwd: root, refreshEnvironment });
    })("codex");
    expect(manager.providerInstallationState("codex")).toBe("unverified");
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(false);
    expect(() => manager.run(input)).toThrow("Inertia has not verified this Codex installation yet.");
  } finally {
    await manager.disposeAll();
    await removePortableFixture(root);
  }
});

it("invalidates admission when a native executable is replaced at the same path", async () => {
  const root = portableFixtureRoot("native installation fingerprint");
  const executable = join(root, process.platform === "win32" ? "codex.exe" : "codex");
  copyFileSync(process.execPath, executable);
  // Keep native file replacement separate from process-image release. The
  // launcher scenario above owns real discovery; neither native copy runs here.
  const manager = ProviderManager.createProduction({
    commands: { codex: executable },
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    conversationProviderGate: () => undefined,
    metadataCache: new ProviderMetadataCache(),
    detectProvider: async () => ({
      provider: PROVIDER_INFO.codex, available: true, executable,
      version: "0.155.0", installState: "installed", authState: "authenticated",
      canRun: true, protocolVerified: true, cleanupConfirmed: true,
    }),
  });
  const input = nativeProviderRunInput({
    providerId: "codex", conversationId: "native-replacement", cwd: root,
    prompt: "Synthetic turn", interactionMode: "build", access: "supervised",
  });
  try {
    await manager.detect("codex");
    const before = manager.providerInstallationIdentityForMaintenance("codex", executable, "0.155.0");
    expect(manager.providerInstallationState("codex")).toBe("current");
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);

    copyFileSync(process.execPath, `${executable}.next`);
    renameSync(`${executable}.next`, executable);

    const after = manager.providerInstallationIdentityForMaintenance("codex", executable, "0.155.0");
    expect(after.scopeId).toBe(before.scopeId);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(manager.providerInstallationState("codex")).toBe("changed");
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(false);
    expect(() => manager.run(input)).toThrow("Codex changed since Inertia last checked it");

    await manager.detect("codex");
    expect(manager.providerInstallationState("codex")).toBe("current");
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);
  } finally {
    try { await manager.disposeAll(); }
    finally { await removePortableFixture(root); }
  }
});

it.each([true, false])("re-verifies a relocated CLI without quarantining the old installation (previously verified: %s)", async (previouslyVerified) => {
  const root = portableFixtureRoot("relocated provider installation");
  const previous = join(root, "old-codex");
  const replacement = join(root, "new-codex");
  writeFileSync(previous, "old installation");
  writeFileSync(replacement, "new installation");
  let executable = previous;
  let protocolVerified = previouslyVerified;
  const leases = new ProviderInstallationLeaseCoordinator();
  const manager = ProviderManager.createProduction({
    installationLeases: leases,
    conversationProviderGate: () => undefined,
    metadataCache: new ProviderMetadataCache(),
    // Discovery's PATH selection changes after a version-manager update.
    // Keep the production fingerprint, lease and admission boundaries real.
    detectProvider: async () => ({
      provider: PROVIDER_INFO.codex, available: true, executable,
      version: "0.155.0", installState: "installed", authState: "authenticated",
      canRun: protocolVerified, protocolVerified, cleanupConfirmed: true,
    }),
  });
  try {
    await manager.detect("codex");
    const priorIdentity = manager.providerInstallationIdentityForMaintenance("codex", previous, "0.155.0");
    const priorRun = leases.acquireUse(priorIdentity, { kind: "provider-run", operationId: "prior-running-turn" });
    unlinkSync(previous);
    executable = replacement;
    protocolVerified = true;
    expect(manager.providerInstallationState("codex")).toBe(previouslyVerified ? "changed" : "unverified");
    const verify = providerInstallationVerifier(manager, async (providerId, refreshEnvironment) => {
      expect(refreshEnvironment).toBe(true);
      await manager.detect(providerId!, { refreshEnvironment });
    });
    await verify("codex");
    expect(manager.providerInstallationState("codex")).toBe("current");
    const nextIdentity = manager.providerInstallationIdentityForMaintenance("codex", replacement, "0.155.0");
    expect(leases.isQuarantined(priorIdentity)).toBe(false);
    expect(leases.isQuarantined(nextIdentity)).toBe(false);
    expect(leases.blockers(priorIdentity)).toEqual([
      expect.objectContaining({ kind: "provider-run", operationId: "prior-running-turn" }),
    ]);
    expect(priorRun.release({ cleanupConfirmed: true })).toBe(true);
    expect(leases.blockers(priorIdentity)).toEqual([]);
    expect(leases.blockers(nextIdentity)).toEqual([]);
  } finally {
    try { await manager.disposeAll(); }
    finally { await removePortableFixture(root); }
  }
});
