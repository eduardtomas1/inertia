// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { ProviderManager } from "../../src/server/providers";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { fakeAppServer as createFakeAppServer } from "../helpers/codex-app-server-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Codex App Server plans", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapturePath = process.env.INERTIA_APP_SERVER_CAPTURE;
  const originalScenario = process.env.INERTIA_APP_SERVER_SCENARIO;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    if (originalCapturePath === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapturePath;
    if (originalScenario === undefined) delete process.env.INERTIA_APP_SERVER_SCENARIO;
    else process.env.INERTIA_APP_SERVER_SCENARIO = originalScenario;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function trackedManager(command: string): ProviderManager {
    const manager = ProviderManager.createForTests({
      commands: { codex: command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: {
          ...environment,
          INERTIA_APP_SERVER_CAPTURE: process.env.INERTIA_APP_SERVER_CAPTURE ?? "",
          INERTIA_APP_SERVER_SCENARIO: process.env.INERTIA_APP_SERVER_SCENARIO ?? "",
        },
      }),
    });
    managers.push(manager);
    return manager;
  }

  it("gives a plan item its steps and leaves reported step statuses to turn plan updates", async () => {
    const fake = createFakeAppServer(roots);
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "plan-progress";
    const manager = trackedManager(fake.command);
    const plans: Array<{ explanation: string | null; steps: unknown[] }> = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-plan-progress",
      cwd: fake.root,
      prompt: "Plan the fix",
      interactionMode: "plan",
      access: "full",
    }), {
      onPlan: (event) => plans.push({ explanation: event.explanation, steps: event.steps }),
    });

    expect(result).toMatchObject({ status: "completed", text: "Done" });
    expect(plans).toEqual([
      {
        explanation: "# Plan\n\n1. Inspect the adapter\n2. Ship the fix",
        steps: [
          { step: "Inspect the adapter", status: "pending" },
          { step: "Ship the fix", status: "pending" },
        ],
      },
      {
        explanation: null,
        steps: [
          { step: "Inspect the adapter", status: "completed" },
          { step: "Ship the fix", status: "inProgress" },
        ],
      },
      {
        explanation: "# Plan\n\n1. Inspect the adapter\n2. Ship the fix\n3. Verify",
        steps: [],
      },
    ]);
    await manager.disposeAll();
  });
});
