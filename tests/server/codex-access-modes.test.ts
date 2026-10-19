// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { ProviderManager } from "../../src/server/providers";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { captured, fakeAppServer as createFakeAppServer } from "../helpers/codex-app-server-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const FIXTURE_KEYS = ["INERTIA_APP_SERVER_CAPTURE", "INERTIA_APP_SERVER_APPROVAL_KIND", "INERTIA_APP_SERVER_SCENARIO"] as const;

describe("Codex access modes", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const original = Object.fromEntries(FIXTURE_KEYS.map((key) => [key, process.env[key]]));
  const fakeAppServer = () => createFakeAppServer(roots);

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    for (const key of FIXTURE_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function trackedManager(command: string): ProviderManager {
    const manager = ProviderManager.createForTests({
      commands: { codex: command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: {
          ...environment,
          ...Object.fromEntries(FIXTURE_KEYS.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
        },
      }),
    });
    managers.push(manager);
    return manager;
  }

  it.each([
    ["auto-edit", "file-change", "in-workspace-file-change", false],
    ["supervised", "file-change", "in-workspace-file-change", true],
    ["auto-edit", "command", undefined, true],
  ] as const)("in %s, a %s approval inside the workspace asks the user: %s", async (access, kind, scenario, asks) => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = kind;
    if (scenario) process.env.INERTIA_APP_SERVER_SCENARIO = scenario;
    const manager = trackedManager(fake.command);
    const asked: string[] = [];
    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: `conversation-${access}-${kind}`,
      cwd: fake.root,
      prompt: "Try an edit",
      interactionMode: "build",
      access,
    }), {
      onApproval: (event) => {
        asked.push(event.request.kind);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve", { runId: event.runId, turnId: event.turnId })).toBe(true);
      },
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] }, { runId: event.runId, turnId: event.turnId })).toBe(true),
    });
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(asked.length > 0).toBe(asks);
    expect(captured(fake.capturePath).find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "accept" } });
    await manager.disposeAll();
  });
});
