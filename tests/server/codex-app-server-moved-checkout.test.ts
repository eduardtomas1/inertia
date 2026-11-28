// @inertia-test-suite portable
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderManager } from "../../src/server/providers";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { captured, fakeAppServer as createFakeAppServer } from "../helpers/codex-app-server-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Codex App Server session cwd mobility", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapturePath = process.env.INERTIA_APP_SERVER_CAPTURE;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    if (originalCapturePath === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapturePath;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function trackedManager(command: string): ProviderManager {
    const manager = ProviderManager.createForTests({
      commands: { codex: command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: { ...environment, INERTIA_APP_SERVER_CAPTURE: process.env.INERTIA_APP_SERVER_CAPTURE ?? "" },
      }),
    });
    managers.push(manager);
    return manager;
  }

  it("resumes a thread by id in the checkout the chat moved to", async () => {
    const fake = createFakeAppServer(roots);
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    const manager = trackedManager(fake.command);
    const moved = join(fake.root, "moved-checkout");
    mkdirSync(moved);
    // The fixture's launcher runs its App Server script from the working directory.
    copyFileSync(join(fake.root, "app-server"), join(moved, "app-server"));
    const sessions: string[] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-moved-checkout",
      cwd: moved,
      prompt: "Continue in the worktree",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-from-original-checkout",
    }), {
      onSession: (event) => sessions.push(event.sessionId),
      onApproval: (event) => manager.respondToApproval(event.conversationId, event.request.requestId, "approve", {
        runId: event.runId, turnId: event.turnId }),
      onInput: (event) => manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] }, {
        runId: event.runId, turnId: event.turnId }),
    });

    expect(result).toMatchObject({ status: "completed", sessionId: "thread-from-original-checkout" });
    expect(sessions).toEqual(["thread-from-original-checkout"]);
    const messages = captured(fake.capturePath);
    expect(messages.some(({ method }) => method === "thread/start")).toBe(false);
    const resumed = messages.filter(({ method }) => method === "thread/resume") as { params: Record<string, unknown> }[];
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.params).toMatchObject({ threadId: "thread-from-original-checkout", cwd: moved });
    const turn = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> };
    expect(turn.params).toMatchObject({ threadId: "thread-from-original-checkout" });
  });
});
