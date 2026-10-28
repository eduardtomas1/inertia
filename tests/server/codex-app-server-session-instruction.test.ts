// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  createCodexAppServerHarness,
  type CodexAppServerHarnessDependencies,
} from "../../src/server/provider/codex-app-server-harness";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { captured, fakeAppServer } from "../helpers/codex-app-server-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const SESSION_INSTRUCTION = "[inertia-chat]\nThis chat's id is chat-1.";

describe("Codex session instructions", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  async function startAndResume(scenario?: string) {
    const fake = fakeAppServer(roots);
    const manager = ProviderManager.createForTests({
      commands: { codex: fake.command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: {
          ...environment,
          INERTIA_APP_SERVER_CAPTURE: fake.capturePath,
          ...(scenario ? { INERTIA_APP_SERVER_SCENARIO: scenario } : {}),
        },
      }),
    });
    managers.push(manager);
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
      sessionInstruction: SESSION_INSTRUCTION,
    }, {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve", { runId: event.runId, turnId: event.turnId })).toBe(true),
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] }, { runId: event.runId, turnId: event.turnId })).toBe(true),
    });
    await expect(run()).resolves.toMatchObject({ status: "completed" });
    await expect(run("thread-existing")).resolves.toMatchObject({ status: "completed" });
    const messages = captured(fake.capturePath);
    return {
      root: fake.root,
      configReads: messages.filter(({ method }) => method === "config/read").map(({ params }) => params),
      start: messages.find(({ method }) => method === "thread/start")?.params as Record<string, unknown>,
      resume: messages.find(({ method }) => method === "thread/resume")?.params as Record<string, unknown>,
    };
  }

  it("keeps the person's configured developer instructions ahead of the session instruction on start and resume", async () => {
    const opened = await startAndResume("configured-developer-instructions");

    expect(opened.configReads).toEqual([
      { includeLayers: false, cwd: opened.root },
      { includeLayers: false, cwd: opened.root },
    ]);
    expect(opened.start.developerInstructions).toBe(`USER_DEVELOPER_RULES\n\n${SESSION_INSTRUCTION}`);
    expect(opened.resume.developerInstructions).toBe(opened.start.developerInstructions);
  });

  it.each([undefined, "config-read-error", "config-read-silent"])(
    "sends the session instruction alone when no configured value is read (%s)",
    async (scenario) => {
      const opened = await startAndResume(scenario);

      expect(opened.configReads).toHaveLength(2);
      expect(opened.start.developerInstructions).toBe(SESSION_INSTRUCTION);
      expect(opened.resume.developerInstructions).toBe(SESSION_INSTRUCTION);
    },
    20_000,
  );

  it.each([
    [{ config: { developer_instructions: "USER_DEVELOPER_RULES" } }, `USER_DEVELOPER_RULES\n\n${SESSION_INSTRUCTION}`],
    [new Error("config unreadable"), SESSION_INSTRUCTION],
  ] as const)("resumes a thread for compaction with the same developer instructions", async (config, expected) => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        requests.push({ method, params });
        if (method === "config/read") {
          if (config instanceof Error) throw config;
          return config;
        }
        if (method === "thread/resume") {
          return { thread: { id: params.threadId }, initialTurnsPage: { data: [{ id: "previous-turn" }] } };
        }
        if (method === "thread/turns/list") return { data: [{ id: "compact-turn-1" }, { id: "previous-turn" }] };
        const lifecycleAtMs = Date.now();
        options.onNotification?.("turn/started", {
          threadId: params.threadId,
          turn: { id: "compact-turn-1", status: "inProgress", items: [], error: null },
        });
        options.onNotification?.("item/started", {
          threadId: params.threadId, turnId: "compact-turn-1", startedAtMs: lifecycleAtMs,
          item: { id: "compact-1", type: "contextCompaction" },
        });
        options.onNotification?.("item/completed", {
          threadId: params.threadId, turnId: "compact-turn-1", completedAtMs: lifecycleAtMs,
          item: { id: "compact-1", type: "contextCompaction" },
        });
        options.onNotification?.("turn/completed", {
          threadId: params.threadId,
          turn: { id: "compact-turn-1", status: "completed", items: [], error: null },
        });
        return {};
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([createCodexAppServerHarness({ withControlClient })]),
    );
    managers.push(manager);

    await expect(manager.compact({
      ...nativeProviderRunInput({
        providerId: "codex",
        conversationId: "codex-compact-session-instruction",
        cwd: process.cwd(),
        prompt: "/compact",
        interactionMode: "build",
        access: "supervised",
        sessionId: "thread-existing",
      }),
      sessionInstruction: SESSION_INSTRUCTION,
    })).resolves.toMatchObject({ status: "completed" });
    expect(requests.map(({ method }) => method)).toEqual([
      "config/read",
      "thread/resume",
      "thread/compact/start",
      "thread/turns/list",
    ]);
    expect(requests.find(({ method }) => method === "thread/resume")?.params.developerInstructions).toBe(expected);
  });
});
