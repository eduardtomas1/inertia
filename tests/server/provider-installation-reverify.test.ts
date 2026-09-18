// @inertia-test-suite portable
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { ProviderManager } from "../../src/server/providers";
import { portableFixtureRoot, removePortableFixture, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

function writeCodexLauncher(path: string): void {
  const staged = `${path}.next`;
  writeFileSync(staged, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, "utf8");
  chmodSync(staged, 0o755);
  renameSync(staged, path);
}

it.skipIf(process.platform === "win32")("re-verifies Codex after its executable is replaced while Inertia runs", async () => {
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
  const executable = join(root, "codex");
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
  } finally {
    await manager.disposeAll();
    await removePortableFixture(root);
  }
});
