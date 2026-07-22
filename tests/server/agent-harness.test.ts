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

function input(
  providerId: ProviderRunInput["providerId"],
  overrides: Partial<ProviderRunInput> = {},
): ProviderRunInput {
  return {
    providerId,
    conversationId: `conversation-${providerId}`,
    cwd: "/workspace",
    prompt: "Inspect this project",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  } as ProviderRunInput;
}

describe("agent harness architecture", () => {
  it("routes every Codex access mode through the App Server harness", () => {
    const registry = createDefaultAgentHarnessRegistry();

    expect(registry.resolve(input("codex")).id).toBe("codex-app-server");
    expect(registry.resolve(input("codex", { access: "auto-edit" })).id).toBe("codex-app-server");
    expect(registry.resolve(input("codex", { access: "full" })).id).toBe("codex-app-server");
    expect(registry.resolve(input("claude")).id).toBe("claude-cli");
    expect(registry.resolve(input("cursor")).id).toBe("cursor-cli");
    expect(registry.resolve(input("opencode")).id).toBe("opencode-cli");
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
      kind: "claude-cli",
      planMode: "native-cli",
      approvals: "unavailable-in-current-harness",
      images: "prompt-path-reference",
    });
    expect(cursor?.extension).toMatchObject({
      kind: "cursor-cli",
      plans: "prompt-emulated",
      reasoning: "suppressed-by-print-mode",
    });
    expect(opencode?.extension).toMatchObject({
      kind: "opencode-cli",
      planMode: "native-agent-selection",
      images: "native-cli-file",
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
      { providerId: "codex", conversationId: "conversation-1", type: "status", status: "starting" },
      {
        providerId: "codex",
        conversationId: "conversation-1",
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
        const result = new Promise<ProviderRunResult>((resolve) => {
          resolveResult = resolve;
        });
        queueMicrotask(() => {
          options.callbacks?.onEvent?.({ providerId: "codex", conversationId: "conversation-codex", type: "status", status: "starting" });
          options.callbacks?.onEvent?.({ providerId: "codex", conversationId: "conversation-codex", type: "status", status: "running" });
          options.callbacks?.onEvent?.({ providerId: "codex", conversationId: "conversation-codex", type: "session", sessionId: "thread-1" });
          options.callbacks?.onEvent?.({ providerId: "codex", conversationId: "conversation-codex", type: "text", text: "Hello" });
          options.callbacks?.onEvent?.({
            providerId: "codex",
            conversationId: "conversation-codex",
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
                providerId: "codex",
                conversationId: "conversation-codex",
                type: "extension",
                extension: "codex-app-server",
                event: { type: "approval-resolved", requestId, decision },
              });
              options.callbacks?.onEvent?.({ providerId: "codex", conversationId: "conversation-codex", type: "status", status: "completed" });
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
          },
        };
      },
    };
    const manager = new ProviderManager({}, new AgentHarnessRegistry([harness]));
    const statuses: string[] = [];
    const sessions: string[] = [];
    const text: string[] = [];
    const approvals: string[] = [];
    const resolved: string[] = [];

    const run = manager.run(input("codex"), {
      onStatus: (event) => statuses.push(event.status),
      onSession: (event) => sessions.push(event.sessionId),
      onText: (event) => text.push(event.text),
      onApproval: (event) => {
        approvals.push(event.request.requestId);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onApprovalResolved: (event) => resolved.push(event.requestId),
    });
    const result = await run;

    expect(harnessOptions.executable).toBe("codex");
    expect(statuses).toEqual(["starting", "running", "completed"]);
    expect(sessions).toEqual(["thread-1"]);
    expect(text).toEqual(["Hello"]);
    expect(approvals).toEqual(["approval-1"]);
    expect(resolved).toEqual(["approval-1"]);
    expect(approvalResponses).toEqual([["approval-1", "approve"]]);
    expect(result).toMatchObject({ status: "completed", sessionId: "thread-1", text: "Hello" });
    expect(manager.activeConversationIds()).toEqual([]);
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
        const result = new Promise<ProviderRunResult>((resolve) => {
          resolveResult = resolve;
        });
        queueMicrotask(() => {
          options.callbacks?.onEvent?.({ providerId: "claude", conversationId: "conversation-claude", type: "status", status: "starting" });
          options.callbacks?.onEvent?.({ providerId: "claude", conversationId: "conversation-claude", type: "session", sessionId: "session-1" });
          options.callbacks?.onEvent?.({ providerId: "claude", conversationId: "conversation-claude", type: "status", status: "running" });
        });
        return {
          harnessId: "claude-cli",
          providerId: "claude",
          result,
          cancel: (force) => {
            cancelCalls.push(force);
            if (force) return;
            options.callbacks?.onEvent?.({ providerId: "claude", conversationId: "conversation-claude", type: "status", status: "cancelling" });
            options.callbacks?.onEvent?.({ providerId: "claude", conversationId: "conversation-claude", type: "status", status: "cancelled" });
            resolveResult({
              providerId: "claude",
              conversationId: "conversation-claude",
              status: "cancelled",
              sessionId: "session-1",
              text: "",
              textTruncated: false,
              exitCode: null,
              signal: "SIGTERM",
            });
          },
          extension: { kind: "cli", providerId: "claude" },
        };
      },
    };
    const manager = new ProviderManager({ cancelGraceMs: 100 }, new AgentHarnessRegistry([harness]));
    const run = manager.run(input("claude"), { onStatus: (event) => statuses.push(event.status) });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(manager.isRunning("conversation-claude")).toBe(true);
    expect(manager.cancel("conversation-claude")).toBe(true);
    await expect(run).resolves.toMatchObject({ status: "cancelled", sessionId: "session-1" });
    expect(statuses).toEqual(["starting", "running", "cancelling", "cancelled"]);
    expect(cancelCalls).toEqual([false]);
    expect(manager.isRunning("conversation-claude")).toBe(false);
    expect(manager.cancel("conversation-claude")).toBe(false);
  });

  it("fails closed when registry routing is missing or ambiguous", () => {
    const harness = (id: "claude-cli" | "cursor-cli", providerId: "claude" | "cursor"): AgentHarness => ({
      id,
      providerId,
      capabilities: CLI_AGENT_HARNESS_CAPABILITIES[providerId],
      supports: () => true,
      start: () => { throw new Error("not reached"); },
    });

    expect(() => new AgentHarnessRegistry([harness("claude-cli", "claude")]).resolve(input("cursor"))).toThrow(
      "No agent harness can run cursor",
    );
    expect(() => new AgentHarnessRegistry([
      { ...createDefaultAgentHarnessRegistry().list("codex")[0]!, supports: () => true },
      createCliAgentHarness("codex", { supports: () => true }),
    ]).resolve(input("codex", { access: "supervised" }))).toThrow("Multiple agent harnesses matched codex");
  });
});
