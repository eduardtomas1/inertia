// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import { providerInstallationVerifier } from "../../src/server/provider/provider-info-refresh";

describe("provider installation verifier", () => {
  it("refreshes a changed or unverified provider with a fresh environment and leaves a current one alone", async () => {
    const states = { codex: "changed", claude: "unverified", kimi: "current" } as const;
    const refresh = vi.fn(async () => undefined);
    const verify = providerInstallationVerifier(
      {
        providerInstallationState: (providerId) => states[providerId as keyof typeof states],
        invalidateInstallationEvidence: vi.fn(),
      },
      refresh,
    );

    await verify("codex");
    await verify("claude");
    await verify("kimi");

    expect(refresh.mock.calls).toEqual([["codex", true], ["claude", true]]);
  });

  it("does not fail a send when the refresh itself fails", async () => {
    const verify = providerInstallationVerifier(
      { providerInstallationState: () => "changed", invalidateInstallationEvidence: vi.fn() },
      vi.fn(async () => { throw new Error("detection failed"); }),
    );

    await expect(verify("codex")).resolves.toBeUndefined();
  });

  it("joins concurrent sends until the refreshed catalog is published", async () => {
    let state: "changed" | "current" = "changed";
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const verify = providerInstallationVerifier(
      { providerInstallationState: () => state, invalidateInstallationEvidence: vi.fn() },
      refresh,
    );
    let completed = 0;
    const first = verify("codex").then(() => { completed += 1; });
    const second = verify("codex").then(() => { completed += 1; });
    // Detection records evidence before metadata enrichment is published.
    state = "current";
    const third = verify("codex").then(() => { completed += 1; });
    await Promise.resolve();
    expect(completed).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second, third]);
    expect(completed).toBe(3);
  });

  it("allows independent providers and another attempt after a failed refresh", async () => {
    let finish!: () => void;
    const refresh = vi.fn(async (providerId?: string) => {
      if (providerId === "codex") await new Promise<void>((resolve) => { finish = resolve; });
      else throw new Error("verification failed");
    });
    const invalidateInstallationEvidence = vi.fn();
    const verify = providerInstallationVerifier({
      providerInstallationState: () => "changed", invalidateInstallationEvidence,
    }, refresh);
    const codex = verify("codex");
    await verify("claude");
    await verify("claude");
    expect(refresh.mock.calls).toEqual([["codex", true], ["claude", true], ["claude", true]]);
    expect(invalidateInstallationEvidence.mock.calls).toEqual([["codex"], ["claude"], ["claude"]]);
    finish();
    await codex;
  });
});
