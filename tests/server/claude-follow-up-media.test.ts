import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  AgentHarnessRegistry,
  ProviderManager,
} from "../../src/server/providers";
import {
  claudeSessionState,
  claudeSuccessResult,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import {
  portableFixtureRoot,
  removePortableFixture,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude media follow-up queue", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(
    roots.splice(0).map(removePortableFixture),
  ));

  it("bounds queued media until the SDK consumes reserved input", async () => {
    const root = portableFixtureRoot("Claude SDK bounded media follow-up");
    roots.push(root);
    const followUpImage = join(root, "follow-up.png");
    writeFileSync(followUpImage, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    let promptIterator: AsyncIterator<SDKUserMessage> | undefined;
    let markInitialPromptRead!: () => void;
    const initialPromptRead = new Promise<void>((resolve) => {
      markInitialPromptRead = resolve;
    });
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => {
        promptIterator = (prompt as AsyncIterable<SDKUserMessage>)[
          Symbol.asyncIterator
        ]();
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            await promptIterator!.next();
            markInitialPromptRead();
            yield claudeSessionState("running");
            await streamReleased;
            yield claudeSuccessResult("Queued media handled", "completed");
            yield claudeSessionState("idle");
          })(),
        );
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const identity = {
      runId: "claude-bounded-media-run",
      turnId: "claude-bounded-media-turn",
    };
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-bounded-media-follow-up",
      ...identity,
      cwd: root,
      prompt: "Start the parent turn",
      interactionMode: "build",
      access: "supervised",
    }));

    await initialPromptRead;
    const steerMedia = (content: string): Promise<boolean> => manager.steer(
      "claude-bounded-media-follow-up",
      { content, imagePaths: [followUpImage] },
      identity,
    );
    await expect(steerMedia("First queued image")).resolves.toBe(true);
    await expect(steerMedia("Rejected while the image budget is held"))
      .resolves.toBe(false);
    await expect(promptIterator!.next()).resolves.toMatchObject({
      done: false,
      value: { type: "user" },
    });
    await expect(steerMedia("Accepted after SDK consumption"))
      .resolves.toBe(true);
    await expect(promptIterator!.next()).resolves.toMatchObject({
      done: false,
      value: { type: "user" },
    });
    releaseStream();

    await expect(result).resolves.toMatchObject({
      status: "completed",
      text: "Queued media handled",
    });
  });
});
