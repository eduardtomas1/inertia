import { describe, expect, it } from "vitest";

import {
  claudeHarnessBackendCompatibility,
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
  modelBackendProfileForClaudeProfile,
} from "../../src/shared/claude-backend-profiles";
import { continuationIdentityForSelection } from "../../src/shared/model-routing";
import {
  claudeBackendProfileRegistrations,
  createClaudeBackendLaunchResolver,
} from "../../src/server/runtime/backends/claude-compatible-adapter";
import { ProviderManager } from "../../src/server/providers";

const enabled = process.env.INERTIA_RUN_KIMI_CLAUDE_INTEGRATION === "1"
  && Boolean(process.env.INERTIA_KIMI_CODE_API_KEY);
const realDescribe = enabled ? describe : describe.skip;

realDescribe("real Kimi through Claude integration", () => {
  it("completes a bounded text turn without exposing its credential", async () => {
    const secret = process.env.INERTIA_KIMI_CODE_API_KEY!;
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:real-smoke",
      secretReference: "secret:kimi-real-smoke",
      primaryModelId: "k3-256k",
    });
    const backendProfile = modelBackendProfileForClaudeProfile(profile);
    const modelSelection = createKimiClaudeModelSelection({
      profile,
      reasoningEffort: "low",
    });
    const registrations = claudeBackendProfileRegistrations([profile]);
    const manager = ProviderManager.createForTests({
      commands: {
        claude: process.env.INERTIA_CLAUDE_CODE_EXECUTABLE ?? "claude",
      },
      ...registrations,
      resolveBackendLaunchOptions: createClaudeBackendLaunchResolver({
        profiles: [profile],
        resolveSecret: async (reference) =>
          reference === profile.secretReference ? secret : null,
      }),
    });
    const usage: Array<number | null> = [];

    const result = await manager.run({
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfile,
      backendCompatibility: claudeHarnessBackendCompatibility(profile),
      modelSelection,
      continuationIdentity: continuationIdentityForSelection(
        modelSelection,
        backendProfile.endpointIdentity,
        true,
      ),
      conversationId: "kimi-real-smoke",
      runId: "kimi-real-smoke-run",
      turnId: "kimi-real-smoke-turn",
      cwd: process.cwd(),
      prompt: "Reply with exactly KIMI_INERTIA_OK and no other text.",
      model: modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort ?? undefined,
      interactionMode: "build",
      access: "supervised",
    }, {
      onUsage: (event) => usage.push(event.usage.totalProcessedTokens),
    });

    expect(result).toMatchObject({
      status: "completed",
      text: expect.stringContaining("KIMI_INERTIA_OK"),
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(usage.length).toBeGreaterThan(0);
  }, 120_000);
});
