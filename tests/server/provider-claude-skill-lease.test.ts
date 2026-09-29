// @inertia-test-suite portable
import { afterEach, expect, it, vi } from "vitest";

import { ProcessTreeTerminationError } from "../../src/server/process-lifecycle";
import { readClaudeAgentSdkSkills } from "../../src/server/provider/claude-skill-query";
import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import { ProviderManager } from "../../src/server/providers";
import { portableFixtureRoot, removePortableFixture, writeNodeSubcommand } from "../helpers/portable-provider-fixture";

vi.mock("../../src/server/provider/claude-skill-query", () => ({
  readClaudeAgentSdkSkills: vi.fn(async () => []),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(readClaudeAgentSdkSkills).mockReset();
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

it.each([
  {
    label: "an ordinary discovery failure releases",
    failure: () => new Error("Claude skill discovery timed out."),
    quarantined: false,
  },
  {
    label: "unconfirmed process-tree cleanup quarantines",
    failure: () => new ProcessTreeTerminationError("Claude skill discovery process tree"),
    quarantined: true,
  },
])("$label the Claude installation", async ({ failure, quarantined }) => {
  const root = portableFixtureRoot("Claude skill lease");
  roots.push(root);
  writeNodeSubcommand(root, "auth", "process.stdout.write(JSON.stringify({ loggedIn: true }));");
  const leases = new ProviderInstallationLeaseCoordinator();
  const manager = ProviderManager.createProduction({
    commands: { claude: process.execPath },
    installationLeases: leases,
  });
  vi.mocked(readClaudeAgentSdkSkills)
    .mockRejectedValueOnce(failure())
    .mockResolvedValue([]);
  try {
    await expect(manager.detect("claude", { cwd: root })).resolves.toMatchObject({ canRun: true });
    await expect(manager.claudeSkills(root, false)).rejects.toThrow();

    expect(leases.hasProviderAuthority("claude")).toBe(quarantined);
    const retry = manager.claudeSkills(root, false);
    if (quarantined) await expect(retry).rejects.toThrow();
    else await expect(retry).resolves.toEqual([]);
  } finally {
    await manager.disposeAll().catch(() => undefined);
  }
});
