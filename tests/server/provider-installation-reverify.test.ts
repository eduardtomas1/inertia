// @inertia-test-suite portable
import { chmodSync, copyFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { ProviderManager } from "../../src/server/providers";
import { providerInstallationVerifier } from "../../src/server/provider/provider-info-refresh";
import { PROVIDER_INFO } from "../../src/server/provider/catalog";
import { portableFixtureRoot, removePortableFixture, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

function writeCodexLauncher(path: string): void {
  const staged = `${path}.next`;
  if (process.platform === "win32") copyFileSync(process.execPath, staged);
  else {
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
  const executable = join(root, process.platform === "win32" ? "codex.exe" : "codex");
  writeCodexLauncher(executable);
  const manager = ProviderManager.createProduction({
    commands: { codex: executable },
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    metadataCache: new ProviderMetadataCache(),
  });
  const input = nativeProviderRunInput({
    providerId: "codex", conversationId: "reverify-after-update", cwd: root,
    prompt: "Synthetic turn", interactionMode: "build", access: "supervised",
  });
  try {
    expect(manager.providerInstallationState("codex")).toBe("unverified");
    expect(() => manager.run(input)).toThrow(
      "Inertia has not verified this Codex installation yet. Open Settings > Providers and choose Refresh all providers, or restart Inertia.",
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
      "Codex changed since Inertia last checked it, for example after an update, and Inertia could not verify the new installation. Open Settings > Providers and choose Refresh all providers, or restart Inertia.",
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
