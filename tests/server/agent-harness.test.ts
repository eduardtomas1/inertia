import { describe, expect, it } from "vitest";

import {
  AgentHarnessRegistry,
  ProviderManager,
  createDefaultAgentHarnessRegistry,
  type AgentHarness,
  type AgentHarnessEvent,
  type AgentHarnessRun,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/providers";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { CLI_AGENT_HARNESS_CAPABILITIES, createCliAgentHarness } from "../../src/server/provider/cli-agent-harness";
import { CODEX_APP_SERVER_HARNESS_CAPABILITIES } from "../../src/server/provider/codex-app-server-harness";
import { nativeProviderRunFields } from "./model-route-fixture";

function input(
  providerId: ProviderRunInput["providerId"],
  overrides: Partial<ProviderRunInput> = {},
): ProviderRunInput {
  const harnessId = overrides.harnessId;
  return {
    ...nativeProviderRunFields(providerId, "provider-default", "", harnessId),
    conversationId: `conversation-${providerId}`,
    runId: `run-${providerId}`,
    turnId: `turn-${providerId}`,
    cwd: "/workspace",
    prompt: "Inspect this project",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  } as ProviderRunInput;
}

function resultForHarness(input: ProviderRunInput, text: string): ProviderRunResult {
  return {
    providerId: input.providerId,
    conversationId: input.conversationId!,
    status: "completed",
    text,
    textTruncated: false,
    exitCode: 0,
    signal: null,
  };
}

describe("agent harness architecture", () => {
  it("routes every Codex access mode through the App Server harness", () => {
    const registry = createDefaultAgentHarnessRegistry();

    expect(registry.resolve(input("codex")).id).toBe("codex-app-server");
    expect(registry.resolve(input("codex", { access: "auto-edit" })).id).toBe("codex-app-server");
    expect(registry.resolve(input("codex", { access: "full" })).id).toBe("codex-app-server");
    expect(registry.resolve(input("claude")).id).toBe("claude-agent-sdk");
    expect(registry.resolve(input("cursor")).id).toBe("cursor-acp");
    expect(registry.resolve(input("opencode")).id).toBe("opencode-sdk");
  });

  it("advertises typed provider extensions instead of common capability booleans", () => {
    const manager = new ProviderManager();
    const codex = manager.harnessCapabilities("codex");
    const claude = manager.harnessCapabilities("claude")[0];
    const cursor = manager.harnessCapabilities("cursor")[0];
    const opencode = manager.harnessCapabilities("opencode")[0];

    expect(codex.map(({ extension }) => extension.kind)).toEqual(["codex-app-server"]);
    expect(codex[0]?.extension).toMatchObject({
      kind: "codex-app-server",
      approvals: "native",
      questions: "native",
      plans: "native",
      reasoning: "summary",
      usage: "token-usage",
      images: "local-image-input",
      modelMetadata: "app-server",
    });
    expect(claude?.extension).toMatchObject({
      kind: "claude-agent-sdk",
      approvals: "native",
      questions: "native",
      plans: "native",
      reasoning: "streaming-thinking",
      usage: "result-usage",
      images: "structured-base64-input",
    });
    expect(cursor?.extension).toMatchObject({
      kind: "cursor-acp",
      approvals: "native",
      questions: "cursor-extension",
      plans: "native",
      reasoning: "native",
      usage: "optional-acp-v1",
      images: "capability-negotiated",
    });
    expect(opencode?.extension).toMatchObject({
      kind: "opencode-sdk",
      approvals: "native",
      questions: "native",
      plans: "native",
      usage: "message-token-usage",
      images: "native-file-input",
    });
  });

  it("keeps Codex extension events typed until the compatibility adapter boundary", () => {
    const events: AgentHarnessEvent[] = [];
    const emitter = createAgentHarnessEmitter("codex", "conversation-1", {
      onEvent: (event) => events.push(event),
    });

    emitter.status("starting");
    emitter.codex({
      type: "plan",
      explanation: "Provider-native plan",
      steps: [{ step: "Inspect", status: "inProgress" }],
    });

    expect(events).toEqual([
      { providerId: "codex", conversationId: "conversation-1", runId: "conversation-1", turnId: null, type: "status", status: "starting" },
      {
        providerId: "codex",
        conversationId: "conversation-1",
        runId: "conversation-1",
        turnId: null,
        type: "extension",
        extension: "codex-app-server",
        event: {
          type: "plan",
          explanation: "Provider-native plan",
          steps: [{ step: "Inspect", status: "inProgress" }],
        },
      },
    ]);
  });

  it("bridges lifecycle, session, text, and Codex interaction extensions to current callbacks", async () => {
    let resolveResult!: (result: ProviderRunResult) => void;
    let harnessOptions!: Parameters<AgentHarness["start"]>[0];
    const approvalResponses: Array<[string, string]> = [];
    const harness: AgentHarness = {
      id: "codex-app-server",
      providerId: "codex",
      capabilities: CODEX_APP_SERVER_HARNESS_CAPABILITIES,
      supports: () => true,
      start: (options): AgentHarnessRun => {
        harnessOptions = options;
        const identity = {
          providerId: "codex" as const,
          conversationId: "conversation-codex",
          runId: options.input.runId!,
          turnId: options.input.turnId ?? null,
        };
        const result = new Promise<ProviderRunResult>((resolve) => {
          resolveResult = resolve;
        });
        queueMicrotask(() => {
          options.callbacks?.onEvent?.({ ...identity, type: "status", status: "starting" });
          options.callbacks?.onEvent?.({ ...identity, type: "status", status: "running" });
          options.callbacks?.onEvent?.({ ...identity, type: "session", sessionId: "thread-1" });
          options.callbacks?.onEvent?.({ ...identity, type: "text", text: "Hello" });
          options.callbacks?.onEvent?.({
            ...identity,
            type: "extension",
            extension: "codex-app-server",
            event: {
              type: "approval",
              request: {
                requestId: "approval-1",
                kind: "command",
                title: "Run command",
                command: "npm test",
                permissionRoots: [],
                availableDecisions: ["approve", "deny", "cancel"],
              },
            },
          });
          options.callbacks?.onEvent?.({
            ...identity,
            type: "extension",
            extension: "codex-app-server",
            event: {
              type: "input",
              request: {
                requestId: "input-1",
                questions: [{
                  id: "choice",
                  header: "Choice",
                  question: "Which option?",
                  isOther: false,
                  isSecret: false,
                  allowMultiple: false,
                  options: [{ id: "one", label: "One", description: "" }],
                }],
                autoResolutionMs: null,
              },
            },
          });
        });
        return {
          harnessId: "codex-app-server",
          providerId: "codex",
          result,
          cancel: () => undefined,
          extension: {
            kind: "codex-app-server",
            respondToApproval: (requestId, decision) => {
              approvalResponses.push([requestId, decision]);
              options.callbacks?.onEvent?.({
                ...identity,
                type: "extension",
                extension: "codex-app-server",
                event: { type: "approval-resolved", requestId, decision },
              });
              options.callbacks?.onEvent?.({ ...identity, type: "status", status: "completed" });
              resolveResult({
                providerId: "codex",
                conversationId: "conversation-codex",
                status: "completed",
                sessionId: "thread-1",
                text: "Hello",
                textTruncated: false,
                exitCode: 0,
                signal: null,
              });
              return true;
            },
            respondToInput: () => false,
            setGoal: async () => ({
              status: "active",
              objective: "Test goal",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
            clearGoal: async () => true,
          },
        };
      },
    };
    const manager = new ProviderManager({}, new AgentHarnessRegistry([harness]));
    const statuses: string[] = [];
    const sessions: string[] = [];
    const text: string[] = [];
    const approvals: string[] = [];
    const inputs: string[] = [];
    const resolved: string[] = [];

    const run = manager.run(input("codex"), {
      onStatus: (event) => statuses.push(event.status),
      onSession: (event) => sessions.push(event.sessionId),
      onText: (event) => text.push(event.text),
      onApproval: (event) => {
        expect(event).toMatchObject({ runId: "run-codex", turnId: "turn-codex" });
        approvals.push(event.request.requestId);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onInput: (event) => {
        expect(event).toMatchObject({ runId: "run-codex", turnId: "turn-codex" });
        inputs.push(event.request.requestId);
      },
      onApprovalResolved: (event) => resolved.push(event.requestId),
    });
    const result = await run;

    expect(harnessOptions.executable).toBe("codex");
    expect(statuses).toEqual(["starting", "running", "completed"]);
    expect(sessions).toEqual(["thread-1"]);
    expect(text).toEqual(["Hello"]);
    expect(approvals).toEqual(["approval-1"]);
    expect(inputs).toEqual(["input-1"]);
    expect(resolved).toEqual(["approval-1"]);
    expect(approvalResponses).toEqual([["approval-1", "approve"]]);
    expect(result).toMatchObject({ status: "completed", sessionId: "thread-1", text: "Hello" });
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("materializes backend launch secrets only at the owned harness boundary", async () => {
    let resolveResult!: (result: ProviderRunResult) => void;
    let resolverEnvironment!: NodeJS.ProcessEnv;
    let harnessEnvironment!: NodeJS.ProcessEnv;
    let harnessModel: string | undefined;
    let released = 0;
    let disposed = 0;
    const harness: AgentHarness = {
      id: "codex-app-server",
      providerId: "codex",
      capabilities: CODEX_APP_SERVER_HARNESS_CAPABILITIES,
      supports: () => true,
      start: (options) => {
        harnessEnvironment = options.environment;
        harnessModel = options.input.model;
        return {
          harnessId: "codex-app-server",
          providerId: "codex",
          result: new Promise<ProviderRunResult>((resolve) => {
            resolveResult = resolve;
          }),
          cancel: () => undefined,
          extension: {
            kind: "codex-app-server",
            respondToApproval: () => false,
            respondToInput: () => false,
            setGoal: async () => ({
              status: "active",
              objective: "Test goal",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
            clearGoal: async () => true,
          },
        };
      },
    };
    const manager = new ProviderManager({
      resolveBackendLaunchOptions: (runInput, baseEnvironment) => {
        expect(JSON.stringify(runInput)).not.toContain("temporary-secret");
        expect(runInput.backendProfile.id).toBe("builtin:openai");
        resolverEnvironment = {
          ...baseEnvironment,
          INERTIA_TEST_BACKEND_SECRET: "temporary-secret",
        };
        return {
          environment: resolverEnvironment,
          modelArgument: "gateway/model-a",
          releaseAfterStart: () => {
            released += 1;
            delete resolverEnvironment.INERTIA_TEST_BACKEND_SECRET;
          },
          dispose: () => {
            disposed += 1;
          },
        };
      },
    }, new AgentHarnessRegistry([harness]));

    const runInput = input("codex");
    const run = manager.run(runInput);
    expect(released).toBe(1);
    expect(disposed).toBe(0);
    expect(resolverEnvironment.INERTIA_TEST_BACKEND_SECRET).toBeUndefined();
    expect(harnessEnvironment.INERTIA_TEST_BACKEND_SECRET).toBe("temporary-secret");
    expect(harnessModel).toBe("gateway/model-a");
    expect(process.env.INERTIA_TEST_BACKEND_SECRET).toBeUndefined();

    resolveResult(resultForHarness(runInput, "complete"));
    await expect(run).resolves.toMatchObject({ status: "completed" });
    expect(disposed).toBe(1);
  });

  it("routes goal mutations only to the exact owned Codex run identity", async () => {
    let resolveResult!: (result: ProviderRunResult) => void;
    const goalInputs: unknown[] = [];
    let clearCount = 0;
    const harness: AgentHarness = {
      id: "codex-app-server",
      providerId: "codex",
      capabilities: CODEX_APP_SERVER_HARNESS_CAPABILITIES,
      supports: () => true,
      start: () => ({
        harnessId: "codex-app-server",
        providerId: "codex",
        result: new Promise<ProviderRunResult>((resolve) => {
          resolveResult = resolve;
        }),
        cancel: () => undefined,
        extension: {
          kind: "codex-app-server",
          respondToApproval: () => false,
          respondToInput: () => false,
          setGoal: async (goalInput) => {
            goalInputs.push(goalInput);
            return {
              objective: goalInput.objective ?? "Existing objective",
              status: goalInput.status,
              tokenBudget: goalInput.tokenBudget ?? null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: "2030-01-01T00:00:00.000Z",
              updatedAt: "2030-01-01T00:00:00.000Z",
            };
          },
          clearGoal: async () => {
            clearCount += 1;
            return clearCount === 1;
          },
        },
      }),
    };
    const manager = new ProviderManager({}, new AgentHarnessRegistry([harness]));
    const run = manager.run(input("codex"));

    await expect(manager.setGoal(
      "conversation-codex",
      { objective: "Owned goal", status: "active", tokenBudget: 8_000 },
      { runId: "wrong-run", turnId: "turn-codex" },
    )).resolves.toBeNull();
    await expect(manager.setGoal(
      "conversation-codex",
      { objective: "Owned goal", status: "active", tokenBudget: 8_000 },
      { runId: "run-codex", turnId: "turn-codex" },
    )).resolves.toMatchObject({ objective: "Owned goal", status: "active" });
    await expect(manager.clearGoal(
      "conversation-codex",
      { runId: "run-codex", turnId: "wrong-turn" },
    )).resolves.toBe(false);
    await expect(manager.clearGoal(
      "conversation-codex",
      { runId: "run-codex", turnId: "turn-codex" },
    )).resolves.toBe(true);
    await expect(manager.clearGoal(
      "conversation-codex",
      { runId: "run-codex", turnId: "turn-codex" },
    )).resolves.toBe("superseded");

    expect(goalInputs).toEqual([{
      objective: "Owned goal",
      status: "active",
      tokenBudget: 8_000,
    }]);
    expect(clearCount).toBe(2);
    resolveResult(resultForHarness(input("codex"), "Done"));
    await run;
  });

  it("rejects mismatched and delayed provider events by conversation, run, and turn identity", async () => {
    let emit!: NonNullable<Parameters<AgentHarness["start"]>[0]["callbacks"]>["onEvent"];
    let resolveResult!: (result: ProviderRunResult) => void;
    const harness: AgentHarness = {
      id: "claude-cli",
      providerId: "claude",
      capabilities: CLI_AGENT_HARNESS_CAPABILITIES.claude,
      supports: () => true,
      start: (options) => {
        emit = options.callbacks?.onEvent;
        const result = new Promise<ProviderRunResult>((resolve) => { resolveResult = resolve; });
        return {
          harnessId: "claude-cli",
          providerId: "claude",
          result,
          cancel: () => undefined,
          extension: { kind: "cli", providerId: "claude" },
        };
      },
    };
    const manager = new ProviderManager({}, new AgentHarnessRegistry([harness]));
    const text: string[] = [];
    const run = manager.run(input("claude", { harnessId: "claude-cli" }), {
      onText: (event) => text.push(event.text),
    });
    const identity = {
      providerId: "claude" as const,
      conversationId: "conversation-claude",
      runId: "run-claude",
      turnId: "turn-claude",
    };

    emit?.({ ...identity, type: "text", text: "accepted" });
    emit?.({ ...identity, turnId: "turn-later", type: "text", text: "wrong turn" });
    emit?.({ ...identity, runId: "run-later", type: "text", text: "wrong run" });
    resolveResult({
      providerId: "claude",
      conversationId: "conversation-claude",
      status: "completed",
      text: "accepted",
      textTruncated: false,
      exitCode: 0,
      signal: null,
    });
    await run;
    emit?.({ ...identity, type: "text", text: "delayed after settlement" });

    expect(text).toEqual(["accepted"]);
  });

  it("owns cancellation in the selected harness and removes the session after settlement", async () => {
    const cancelCalls: boolean[] = [];
    const statuses: string[] = [];
    let resolveResult!: (result: ProviderRunResult) => void;
    const harness: AgentHarness = {
      id: "claude-cli",
      providerId: "claude",
      capabilities: CLI_AGENT_HARNESS_CAPABILITIES.claude,
      supports: () => true,
      start: (options) => {
        const identity = {
          providerId: "claude" as const,
          conversationId: "conversation-claude",
          runId: options.input.runId!,
          turnId: options.input.turnId ?? null,
        };
        const result = new Promise<ProviderRunResult>((resolve) => {
          resolveResult = resolve;
        });
        queueMicrotask(() => {
          options.callbacks?.onEvent?.({ ...identity, type: "status", status: "starting" });
          options.callbacks?.onEvent?.({ ...identity, type: "session", sessionId: "session-1" });
          options.callbacks?.onEvent?.({ ...identity, type: "status", status: "running" });
        });
        return {
          harnessId: "claude-cli",
          providerId: "claude",
          result,
          cancel: (force) => {
            cancelCalls.push(force);
            if (force) return;
            options.callbacks?.onEvent?.({ ...identity, type: "status", status: "cancelling" });
            options.callbacks?.onEvent?.({ ...identity, type: "status", status: "cancelled" });
            resolveResult({
              providerId: "claude",
              conversationId: "conversation-claude",
              status: "cancelled",
              sessionId: "session-1",
              text: "",
              textTruncated: false,
              exitCode: null,
              signal: null,
            });
          },
          extension: { kind: "cli", providerId: "claude" },
        };
      },
    };
    const manager = new ProviderManager({ cancelGraceMs: 100 }, new AgentHarnessRegistry([harness]));
    const run = manager.run(input("claude", { harnessId: "claude-cli" }), {
      onStatus: (event) => statuses.push(event.status),
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(manager.isRunning("conversation-claude")).toBe(true);
    expect(manager.cancel("conversation-claude")).toBe(true);
    await expect(run).resolves.toMatchObject({ status: "cancelled", sessionId: "session-1" });
    expect(statuses).toEqual(["starting", "running", "cancelling", "cancelled"]);
    expect(cancelCalls).toEqual([false]);
    expect(manager.isRunning("conversation-claude")).toBe(false);
    expect(manager.cancel("conversation-claude")).toBe(false);
  });

  it("force-stops only an exactly owned temporary run and makes its late events inert", async () => {
    const emitters = new Map<string, NonNullable<Parameters<AgentHarness["start"]>[0]["callbacks"]>["onEvent"]>();
    const resolvers = new Map<string, (result: ProviderRunResult) => void>();
    const cancelCalls = new Map<string, boolean[]>();
    const harness: AgentHarness = {
      id: "claude-cli",
      providerId: "claude",
      capabilities: CLI_AGENT_HARNESS_CAPABILITIES.claude,
      supports: () => true,
      start: (options) => {
        const conversationId = options.input.conversationId!;
        emitters.set(conversationId, options.callbacks?.onEvent);
        cancelCalls.set(conversationId, []);
        const result = new Promise<ProviderRunResult>((resolve) => {
          resolvers.set(conversationId, resolve);
        });
        return {
          harnessId: "claude-cli",
          providerId: "claude",
          result,
          cancel: (force) => {
            cancelCalls.get(conversationId)?.push(force);
            // Deliberately never settle the isolated harness, even after force,
            // to exercise the bounded detach path.
          },
          extension: { kind: "cli", providerId: "claude" },
        };
      },
    };
    const manager = new ProviderManager({ cancelGraceMs: 10_000 }, new AgentHarnessRegistry([harness]));
    const ordinaryInput = input("claude", {
      harnessId: "claude-cli",
      conversationId: "ordinary-conversation",
      runId: "ordinary-run",
      turnId: "ordinary-turn",
    });
    const isolatedInput = input("claude", {
      harnessId: "claude-cli",
      conversationId: "isolated-conversation",
      runId: "isolated-run",
      turnId: "isolated-turn",
      interactionMode: "plan",
    });
    const ordinaryText: string[] = [];
    const isolatedText: string[] = [];
    const ordinary = manager.run(ordinaryInput, {
      onText: ({ text }) => ordinaryText.push(text),
    });
    void manager.run(isolatedInput, {
      onText: ({ text }) => isolatedText.push(text),
    });

    await expect(manager.stopOwned(
      "isolated-conversation",
      { runId: "wrong-run", turnId: "isolated-turn" },
      1,
    )).resolves.toBe("identity-mismatch");
    expect(cancelCalls.get("isolated-conversation")).toEqual([]);

    await expect(manager.stopOwned(
      "isolated-conversation",
      { runId: "isolated-run", turnId: "isolated-turn" },
      1,
    )).resolves.toBe("force-detached");
    expect(cancelCalls.get("isolated-conversation")).toEqual([false, true]);
    expect(manager.isRunning("isolated-conversation")).toBe(false);
    expect(manager.isRunning("ordinary-conversation")).toBe(true);

    emitters.get("isolated-conversation")?.({
      providerId: "claude",
      conversationId: "isolated-conversation",
      runId: "isolated-run",
      turnId: "isolated-turn",
      type: "text",
      text: "late isolated text",
    });
    expect(isolatedText).toEqual([]);

    emitters.get("ordinary-conversation")?.({
      providerId: "claude",
      conversationId: "ordinary-conversation",
      runId: "ordinary-run",
      turnId: "ordinary-turn",
      type: "text",
      text: "ordinary text",
    });
    resolvers.get("ordinary-conversation")?.(resultForHarness(
      ordinaryInput,
      "ordinary text",
    ));
    await expect(ordinary).resolves.toMatchObject({ status: "completed" });
    expect(ordinaryText).toEqual(["ordinary text"]);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("bounds global shutdown and force-detaches malformed runs concurrently", async () => {
    const cancelCalls = new Map<string, boolean[]>();
    const harness: AgentHarness = {
      id: "claude-cli",
      providerId: "claude",
      capabilities: CLI_AGENT_HARNESS_CAPABILITIES.claude,
      supports: () => true,
      start: (options) => {
        const conversationId = options.input.conversationId!;
        cancelCalls.set(conversationId, []);
        return {
          harnessId: "claude-cli",
          providerId: "claude",
          result: new Promise<ProviderRunResult>(() => undefined),
          cancel: (force) => {
            cancelCalls.get(conversationId)?.push(force);
          },
          extension: { kind: "cli", providerId: "claude" },
        };
      },
    };
    const manager = new ProviderManager(
      { cancelGraceMs: 100 },
      new AgentHarnessRegistry([harness]),
    );
    for (let index = 0; index < 3; index += 1) {
      void manager.run(input("claude", {
        harnessId: "claude-cli",
        conversationId: `shutdown-${index}`,
        runId: `run-${index}`,
        turnId: `turn-${index}`,
      }));
    }
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const startedAt = performance.now();
    await manager.disposeAll();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(700);
    expect(manager.activeConversationIds()).toEqual([]);
    for (const calls of cancelCalls.values()) {
      expect(calls[0]).toBe(false);
      expect(calls).toContain(true);
    }
  });

  it("fails closed when an explicitly selected harness is unavailable", () => {
    const harness = (id: "claude-cli" | "cursor-cli", providerId: "claude" | "cursor"): AgentHarness => ({
      id,
      providerId,
      capabilities: CLI_AGENT_HARNESS_CAPABILITIES[providerId],
      supports: () => true,
      start: () => { throw new Error("not reached"); },
    });

    expect(() => new AgentHarnessRegistry([harness("claude-cli", "claude")]).resolve(
      input("cursor", { harnessId: "cursor-cli" }),
    )).toThrow(
      "Agent harness 'cursor-cli' is unavailable",
    );
    expect(() => new AgentHarnessRegistry([
      { ...createDefaultAgentHarnessRegistry().list("codex")[0]!, supports: () => true },
      createCliAgentHarness("codex", { supports: () => true }),
    ]).resolve(input("codex", {
      harnessId: "codex-cli",
      access: "supervised",
    }))).not.toThrow();
  });
});
