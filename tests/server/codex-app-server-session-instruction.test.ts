// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { ProviderManager } from "../../src/server/providers";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { captured, fakeAppServer } from "../helpers/codex-app-server-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Codex session instructions", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("sends the same session instruction as developer instructions when a thread starts and resumes", async () => {
    const fake = fakeAppServer(roots);
    const manager = ProviderManager.createForTests({
      commands: { codex: fake.command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: { ...environment, INERTIA_APP_SERVER_CAPTURE: fake.capturePath },
      }),
    });
    managers.push(manager);
    const sessionInstruction = "[inertia-chat]\nThis chat's id is chat-1.";
    const run = (sessionId?: string) => manager.run({
      ...nativeProviderRunInput({
        providerId: "codex",
        conversationId: `conversation-session-instruction-${sessionId ?? "new"}`,
        cwd: fake.root,
        prompt: "Hello",
        interactionMode: "build",
        access: "supervised",
        ...(sessionId ? { sessionId } : {}),
      }),
      sessionInstruction,
    }, {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve", { runId: event.runId, turnId: event.turnId })).toBe(true),
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] }, { runId: event.runId, turnId: event.turnId })).toBe(true),
    });

    await expect(run()).resolves.toMatchObject({ status: "completed" });
    await expect(run("thread-existing")).resolves.toMatchObject({ status: "completed" });
    const messages = captured(fake.capturePath);
    expect(messages.some(({ method }) => method === "config/read")).toBe(false);
    expect(messages.find(({ method }) => method === "thread/start")?.params)
      .toMatchObject({ developerInstructions: sessionInstruction });
    expect(messages.find(({ method }) => method === "thread/resume")?.params)
      .toMatchObject({ developerInstructions: sessionInstruction });
  });
});
