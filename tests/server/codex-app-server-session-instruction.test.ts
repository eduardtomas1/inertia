// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  createCodexAppServerHarness,
  type CodexAppServerHarnessDependencies,
} from "../../src/server/provider/codex-app-server-harness";
import { INTERNAL_PROVIDER_INSTRUCTIONS_HEADER } from "../../src/server/internal-provider-instructions";
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
    const results: unknown[] = [];
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
    results.push(await run());
    results.push(await run("thread-existing"));
    const messages = captured(fake.capturePath);
    const turnText = (index: number): unknown => {
      const params = messages.filter(({ method }) => method === "turn/start")[index]?.params as
        { input?: Array<{ text?: unknown }> } | undefined;
      return params?.input?.[0]?.text;
    };
    return {
      results,
      turnTexts: [turnText(0), turnText(1)],
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
    expect(opened.turnTexts).toEqual(["Hello", "Hello"]);
    for (const result of opened.results) expect(result).not.toHaveProperty("sessionInstructionApplied");
  });

  it("sends the session instruction alone when the person configured none", async () => {
    const opened = await startAndResume();

    expect(opened.configReads).toHaveLength(2);
    expect(opened.start.developerInstructions).toBe(SESSION_INSTRUCTION);
    expect(opened.resume.developerInstructions).toBe(SESSION_INSTRUCTION);
    expect(opened.turnTexts).toEqual(["Hello", "Hello"]);
  });

  it.each(["config-read-error", "config-read-silent"])(
    "keeps the person's own developer instructions and moves the session instruction into the prompt when config cannot be read (%s)",
    async (scenario) => {
      const opened = await startAndResume(scenario);

      expect(opened.configReads).toHaveLength(2);
      expect(opened.start).not.toHaveProperty("developerInstructions");
      expect(opened.resume).not.toHaveProperty("developerInstructions");
      expect(opened.turnTexts).toEqual([0, 1].map(() => `Hello\n\n${INTERNAL_PROVIDER_INSTRUCTIONS_HEADER}\n${SESSION_INSTRUCTION}`));
      for (const result of opened.results) {
        expect(result).toMatchObject({ status: "completed", sessionInstructionApplied: false });
      }
    },
    20_000,
  );

  it.each([
    [{ config: { developer_instructions: "USER_DEVELOPER_RULES" } }, `USER_DEVELOPER_RULES\n\n${SESSION_INSTRUCTION}`],
    [new Error("config unreadable"), undefined],
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

    const compacted = manager.compact({
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
    });
    const result = await compacted;
    expect(result).toMatchObject({ status: "completed" });
    if (expected === undefined) expect(result).toMatchObject({ sessionInstructionApplied: false });
    else expect(result).not.toHaveProperty("sessionInstructionApplied");
    expect(requests.map(({ method }) => method)).toEqual([
      "config/read",
      "thread/resume",
      "thread/compact/start",
      "thread/turns/list",
    ]);
    expect(requests.find(({ method }) => method === "thread/resume")?.params.developerInstructions).toBe(expected);
  });
});
