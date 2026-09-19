// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import { providerInstallationVerifier } from "../../src/server/provider/provider-info-refresh";

describe("provider installation verifier", () => {
  it("refreshes a changed or unverified provider with a fresh environment and leaves a current one alone", async () => {
    const states = { codex: "changed", claude: "unverified", kimi: "current" } as const;
    const refresh = vi.fn(async () => undefined);
    const verify = providerInstallationVerifier(
      { providerInstallationState: (providerId) => states[providerId as keyof typeof states] },
      refresh,
    );

    await verify("codex");
    await verify("claude");
    await verify("kimi");

    expect(refresh.mock.calls).toEqual([["codex", true], ["claude", true]]);
  });

  it("does not fail a send when the refresh itself fails", async () => {
    const verify = providerInstallationVerifier(
      { providerInstallationState: () => "changed" },
      vi.fn(async () => { throw new Error("detection failed"); }),
    );

    await expect(verify("codex")).resolves.toBeUndefined();
  });
});
