// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/environment", async (original) => ({
  ...await original<typeof import("../../src/server/environment")>(),
  providerEnvironment: async () => ({ env: {}, pathEntries: [] }),
}));

import { detectProvider } from "../../src/server/provider/discovery";

async function detection(
  providerId: "codex" | "claude",
  output: string,
  exitCode: number | null = 0,
) {
  return await detectProvider(providerId, { cwd: "/synthetic" }, {
    executableCandidates: async () => [`/synthetic/${providerId}`],
    probeProcess: async (_executable, args) => ({
      started: true,
      timedOut: false,
      cleanupConfirmed: true,
      exitCode: args[0] === "--version" || args.includes("--help") ? 0 : exitCode,
      output: args[0] === "--version"
        ? `${providerId} 1.2.3`
        : args.includes("--help") ? "app-server acp" : output,
    }),
  });
}

describe("codex authentication readiness", () => {
  it.each(["Not authenticated", "Unauthenticated", "Logged out", "Not signed in"])(
    "refuses the negative status %s even when the status command succeeds",
    async (output) => {
      await expect(detection("codex", output)).resolves.toMatchObject({
        authState: "unauthenticated", canRun: false,
      });
    },
  );

  it.each([1, null])("does not accept positive-looking output after exit %s", async (exitCode) => {
    await expect(detection("codex", "Previously authenticated; status check failed", exitCode))
      .resolves.toMatchObject({ canRun: false });
  });

  it("keeps a successful authenticated status runnable", async () => {
    await expect(detection("codex", "Authenticated")).resolves.toMatchObject({
      authState: "authenticated", canRun: true,
    });
  });
});

it("keeps Claude's structured signed-out status authoritative", async () => {
  await expect(detection("claude", JSON.stringify({ loggedIn: false, message: "Previously authenticated" })))
    .resolves.toMatchObject({ authState: "unauthenticated", canRun: false });
});

it("does not accept Claude's structured signed-in status from a failed probe", async () => {
  await expect(detection("claude", JSON.stringify({ loggedIn: true }), 1))
    .resolves.toMatchObject({ canRun: false });
});
