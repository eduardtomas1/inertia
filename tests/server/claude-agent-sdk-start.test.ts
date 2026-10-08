// @inertia-test-suite portable
import { afterEach, expect, it } from "vitest";

import type { Query, SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { claudeSuccessResult } from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

it("marks Claude running without waiting for its model metadata", async () => {
  const root = portableFixtureRoot("Claude SDK background metadata");
  roots.push(root);
  let releaseModels!: () => void;
  const modelsReleased = new Promise<void>((resolve) => { releaseModels = resolve; });
  let reportMetadata!: () => void;
  const metadataReported = new Promise<void>((resolve) => { reportMetadata = resolve; });
  const harness = createClaudeAgentSdkHarness({
    createQuery: () => {
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        await metadataReported;
        yield {
          ...claudeSuccessResult("Claude response"),
          session_id: "77777777-7777-4777-8777-777777777777",
        } satisfies SDKResultSuccess;
      })();
      return Object.assign(stream, {
        supportedModels: async () => {
          await modelsReleased;
          return [{
            value: "sonnet",
            resolvedModel: "claude-sonnet-test",
            displayName: "Sonnet",
            description: "Balanced model",
            supportsEffort: true,
            supportedEffortLevels: ["high"],
          }];
        },
        interrupt: async () => undefined,
        close: () => undefined,
      }) as unknown as Query;
    },
  });
  const manager = ProviderManager.createForTests(
    { commands: { claude: process.execPath } },
    new AgentHarnessRegistry([harness]),
  );
  const events: string[] = [];

  const result = await manager.run(nativeProviderRunInput({
    providerId: "claude",
    conversationId: "claude-background-metadata",
    cwd: root,
    prompt: "Start",
    interactionMode: "build",
    access: "supervised",
  }), {
    onStatus: ({ status }) => {
      events.push(status);
      if (status === "running") releaseModels();
    },
    onMetadata: (event) => {
      events.push(`models:${(event.metadata.models ?? []).map(({ id }) => id).join(",")}`);
      reportMetadata();
    },
  });

  expect(result).toMatchObject({ status: "completed" });
  expect(events.slice(0, 3)).toEqual(["starting", "running", "models:sonnet"]);
});
