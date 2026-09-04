import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const discoveryHarness = vi.hoisted((): { pathEntries: string[] } => ({
  pathEntries: [],
}));

vi.mock("../../src/server/environment", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/server/environment")
  >();
  return {
    ...actual,
    providerEnvironment: async () => ({
      env: {
        ...process.env,
        PATH: discoveryHarness.pathEntries.join(delimiter),
      },
      pathEntries: [...discoveryHarness.pathEntries],
    }),
  };
});

import {
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
  KIMI_CODING_BASE_URL,
  modelSelectionIdentityLabel,
} from "../../src/shared/claude-backend-profiles";
import type {
  AppSnapshot,
  ConversationDetail,
  ServerEvent,
} from "../../src/shared/contracts";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessStartOptions,
} from "../../src/server/provider/agent-harness";
import { AgentHarnessRegistry } from "../../src/server/provider/agent-harness-registry";
import { CLAUDE_AGENT_SDK_CAPABILITIES } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  providerRunTerminal,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import type { RunningRuntime } from "../../src/server";
import { startTestRuntime as startRuntime } from "../support/test-runtime";

const SECRET_REFERENCE = "secret:kimi-runtime-lifecycle";
const SECRET_VALUE = "kimi-runtime-lifecycle-secret";
const KIMI_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
] as const;

class EventQueue {
  private readonly events: ServerEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      const parsed = JSON.parse(data.toString()) as ServerEvent;
      this.events.push(parsed.type === "runtime.event" ? parsed.event : parsed);
      for (const listener of this.listeners) listener();
    });
  }

  async next<T extends ServerEvent>(
    predicate: (event: ServerEvent) => event is T,
  ): Promise<T> {
    const take = (): T | undefined => {
      const index = this.events.findIndex(predicate);
      if (index < 0) return undefined;
      return this.events.splice(index, 1)[0] as T;
    };
    const existing = take();
    if (existing) return existing;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(
          `Timed out waiting for Kimi runtime event; pending: ${
            this.events.map((event) => event.type === "request.error"
              ? `${event.type}:${event.requestId}:${event.message}`
              : event.type === "agent.failed"
                ? `${event.type}:${event.message}`
                : event.type).join(", ") || "none"
          }.`,
        ));
      }, 8_000);
      const check = (): void => {
        const event = take();
        if (!event) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolve(event);
      };
      this.listeners.add(check);
    });
  }
}

async function connect(
  websocketUrl: string,
): Promise<{ socket: WebSocket; events: EventQueue }> {
  const socket = new WebSocket(websocketUrl, { origin: "http://localhost:5173" });
  const events = new EventQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, events };
}

function send(socket: WebSocket, command: object): void {
  socket.send(JSON.stringify(command));
}

async function detail(
  socket: WebSocket,
  events: EventQueue,
  conversationId: string,
): Promise<ConversationDetail> {
  const requestId = randomUUID();
  send(socket, {
    type: "conversation.detail.load",
    requestId,
    payload: { conversationId },
  });
  const event = await events.next(
    (candidate): candidate is Extract<ServerEvent, { type: "request.result" }> =>
      candidate.type === "request.result"
      && candidate.requestId === requestId
      && candidate.result.kind === "conversation.detail",
  );
  if (event.result.kind !== "conversation.detail" || event.result.state !== "ready") {
    throw new Error("The Kimi conversation detail was unavailable.");
  }
  return event.result.detail;
}

function requestOk(
  events: EventQueue,
  requestId: string,
): Promise<Extract<ServerEvent, { type: "request.ok" }>> {
  return events.next(
    (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
      event.type === "request.ok" && event.requestId === requestId,
  );
}

function fakeClaudeExecutable(root: string): void {
  const directory = join(root, "provider-bin");
  mkdirSync(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("2.1.219\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(1);
}
process.exit(2);
`);
  chmodSync(executable, 0o755);
  discoveryHarness.pathEntries = [directory];
  process.env.PATH = [directory, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
}

function capturingClaudeHarness(
  captures: AgentHarnessStartOptions[],
): AgentHarness {
  return {
    id: "claude-agent-sdk",
    providerId: "claude",
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
    supports: (input) => input.harnessId === "claude-agent-sdk",
    start: (options) => {
      captures.push(options);
      const input = options.input;
      const conversationId = input.conversationId!;
      const emitter = createAgentHarnessEmitter(
        "claude",
        conversationId,
        options.callbacks,
        input.runId,
        input.turnId,
      );
      const sessionId = "kimi-session-1";
      emitter.status("starting");
      emitter.status("running");
      emitter.session(sessionId);
      emitter.text("Kimi runtime lifecycle complete.");
      emitter.rich({
        type: "usage",
        usage: {
          usedTokens: 24,
          totalProcessedTokens: 31,
          totalProcessedScope: "run",
          maxTokens: 1_048_576,
          inputTokens: 20,
          cachedInputTokens: 3,
          cacheWriteInputTokens: null,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          compactsAutomatically: true,
        },
      });
      emitter.status("completed");
      const result: ProviderRunResult = {
        ...providerRunTerminal(input, "completed"),
        sessionId,
        text: "Kimi runtime lifecycle complete.",
        textTruncated: false,
        exitCode: 0,
        signal: null,
      cleanupConfirmed: true,
      };
      return {
        harnessId: "claude-agent-sdk",
        providerId: "claude",
        result: Promise.resolve(result),
        cancel: () => undefined,
        extension: {
          kind: "claude-agent-sdk",
          respondToApproval: () => false,
          respondToInput: () => false,
        },
      };
    },
  };
}

describe("Kimi through Claude runtime lifecycle", () => {
  const lifecycleIt = process.platform === "win32" ? it.skip : it;
  const runtimes: RunningRuntime[] = [];
  const sockets: WebSocket[] = [];
  const directories: string[] = [];
  const originalPath = process.env.PATH;

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    discoveryHarness.pathEntries = [];
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  lifecycleIt("creates, selects, validates, launches, records usage, and reloads the exact historical selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-kimi-lifecycle-"));
    const dataDirectory = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(dataDirectory);
    mkdirSync(workspace);
    directories.push(root);
    fakeClaudeExecutable(root);

    const profile = createKimiClaudeBackendProfile({
      id: "kimi:lifecycle",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
      contextWindowTokens: 1_048_576,
      autoCompactionThresholdPercent: 90,
    });
    const selection = createKimiClaudeModelSelection({
      profile,
      reasoningEffort: "xhigh",
    });
    const captures: AgentHarnessStartOptions[] = [];
    const backendCredentials = {
      resolve: async (reference: string) =>
        reference === SECRET_REFERENCE ? SECRET_VALUE : null,
      has: async (reference: string) => reference === SECRET_REFERENCE,
      status: async (reference: string) => ({
        hasSecret: reference === SECRET_REFERENCE,
        credentialGeneration: reference === SECRET_REFERENCE
          ? "generation:kimi-lifecycle"
          : null,
      }),
      clear: async () => false,
      forget: async () => false,
    };
    const registry = new AgentHarnessRegistry([
      capturingClaudeHarness(captures),
    ]);
    const beforeEnvironment = Object.fromEntries(
      KIMI_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
    );
    const runtime = await startRuntime({
      dataDirectory,
      defaultWorkspacePath: workspace,
      enableProviders: true,
      runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      kimiClaudeProfiles: [profile],
      backendCredentials,
      agentHarnessRegistry: registry,
    });
    runtimes.push(runtime);
    const client = await connect(runtime.websocketUrl);
    sockets.push(client.socket);
    const welcome = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const readySnapshot = await (async (): Promise<AppSnapshot> => {
      const detected = welcome.snapshot.providers.find(({ id }) => id === "claude");
      if (
        detected?.installState === "installed"
        && detected.authState === "unauthenticated"
        && !detected.canRun
      ) return welcome.snapshot;
      return (await client.events.next(
        (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
          event.type === "snapshot.updated"
          && event.snapshot.providers.some((provider) =>
            provider.id === "claude"
            && provider.installState === "installed"
            && provider.authState === "unauthenticated"
            && !provider.canRun),
      )).snapshot;
    })();
    expect(readySnapshot.providers.find(({ id }) => id === "claude")).toMatchObject({
      installState: "installed",
      authState: "unauthenticated",
      canRun: false,
      models: [],
      rateLimits: [],
    });

    const createProjectRequestId = randomUUID();
    send(client.socket, {
      type: "project.create",
      requestId: createProjectRequestId,
      payload: { name: "Kimi lifecycle", path: workspace },
    });
    const projectCreated = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === createProjectRequestId
        && event.result.kind === "project.created",
    );
    if (projectCreated.result.kind !== "project.created") {
      throw new Error("The Kimi lifecycle project was not created.");
    }
    const projectSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.projects.some(({ name }) => name === "Kimi lifecycle"),
    );
    const projectId = projectCreated.result.projectId;
    expect(projectSnapshot.snapshot.projects).toContainEqual(
      expect.objectContaining({ id: projectId, name: "Kimi lifecycle" }),
    );

    const createConversationRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.create",
      requestId: createConversationRequestId,
      payload: {
        projectId,
        title: "Kimi K3",
        modelSelection: selection,
      },
    });
    await requestOk(client.events, createConversationRequestId);
    const conversationSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.conversations.some(({ title }) => title === "Kimi K3"),
    );
    const conversation = conversationSnapshot.snapshot.conversations.find(
      ({ title }) => title === "Kimi K3",
    )!;
    expect(conversation.modelSelection).toEqual(selection);
    expect(modelSelectionIdentityLabel(conversation.modelSelection))
      .toBe("Claude harness · Kimi · K3");

    const selectRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.select",
      requestId: selectRequestId,
      payload: { conversationId: conversation.id },
    });
    await requestOk(client.events, selectRequestId);
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.activeConversationId === conversation.id,
    );

    const invalidLegacyRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.update",
      requestId: invalidLegacyRequestId,
      payload: { conversationId: conversation.id, model: "k3-later-invalid" },
    });
    const invalidLegacy = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error"
        && event.requestId === invalidLegacyRequestId,
    );
    expect(invalidLegacy.message).toBe(
      "External backend model and reasoning changes require a verified model selection.",
    );

    const invalidSelectionRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.update",
      requestId: invalidSelectionRequestId,
      payload: {
        conversationId: conversation.id,
        modelSelection: { ...selection, modelId: "k3-later-invalid" },
      },
    });
    const invalidSelection = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error"
        && event.requestId === invalidSelectionRequestId,
    );
    expect(invalidSelection.message).not.toContain(SECRET_VALUE);
    expect((await detail(client.socket, client.events, conversation.id)).conversation.modelSelection)
      .toEqual(selection);

    const reasoningSelection = { ...selection, reasoningEffort: "low" };
    const reasoningRequestId = randomUUID();
    send(client.socket, {
      type: "conversation.update",
      requestId: reasoningRequestId,
      payload: {
        conversationId: conversation.id,
        modelSelection: reasoningSelection,
      },
    });
    await requestOk(client.events, reasoningRequestId);
    const reasoningSnapshot = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "snapshot.updated" }> =>
        event.type === "snapshot.updated"
        && event.snapshot.conversations.some((candidate) =>
          candidate.id === conversation.id
          && candidate.modelSelection.reasoningEffort === "low"),
    );
    expect(reasoningSnapshot.snapshot.conversations.find(({ id }) =>
      id === conversation.id)?.modelSelection).toEqual({
      ...reasoningSelection,
    });

    const messageRequestId = randomUUID();
    send(client.socket, {
      type: "message.send",
      requestId: messageRequestId,
      payload: {
        conversationId: conversation.id,
        content: "Exercise the verified Kimi runtime.",
        attachments: [],
      },
    });
    const accepted = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.result" }> =>
        event.type === "request.result"
        && event.requestId === messageRequestId
        && event.result.kind === "message.accepted",
    );
    expect(accepted.result).toMatchObject({
      kind: "message.accepted",
      conversationId: conversation.id,
      disposition: "new-turn",
    });
    const usageEvent = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "agent.usage" }> =>
        event.type === "agent.usage"
        && event.usage.conversationId === conversation.id,
    );
    const completedEvent = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "agent.completed" }> =>
        event.type === "agent.completed"
        && event.conversationId === conversation.id,
    );
    expect(completedEvent).toMatchObject({
      runId: expect.any(String),
      turnId: expect.any(String),
    });
    expect(usageEvent.usage).toMatchObject({
      turnId: expect.any(String),
      usedTokens: 24,
      maxTokens: 1_048_576,
      totalProcessedScope: "run",
    });

    expect(captures).toHaveLength(1);
    const launch = captures[0]!;
    expect(launch.input.modelSelection).toEqual(reasoningSelection);
    expect(launch.input.model).toBe("k3[1m]");
    expect(launch.input.sessionId).toBeUndefined();
    expect(launch.environment).toMatchObject({
      ANTHROPIC_API_KEY: SECRET_VALUE,
      ANTHROPIC_BASE_URL: KIMI_CODING_BASE_URL,
      ANTHROPIC_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "k3[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "k3[1m]",
      CLAUDE_CODE_EFFORT_LEVEL: "low",
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1048576",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
    });
    expect(Object.fromEntries(
      KIMI_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
    )).toEqual(beforeEnvironment);

    const completedDetail = await detail(
      client.socket,
      client.events,
      conversation.id,
    );
    expect(completedDetail.agentTurns).toHaveLength(1);
    const turn = completedDetail.agentTurns[0]!;
    expect(turn.modelSelection).toEqual(reasoningSelection);
    expect(turn.providerSessionBefore).toBeNull();
    expect(turn.providerSessionAfter).toBe("kimi-session-1");
    expect(turn.continuationIdentity).toMatchObject({
      harnessId: "claude-agent-sdk",
      backendProfileId: profile.id,
      backendConfigurationRevision: profile.configurationRevision,
      modelIdentity: "k3",
      endpointIdentity: profile.endpointIdentity,
    });
    expect(turn.usageAtCompletion).toMatchObject({
      usedTokens: 24,
      maxTokens: 1_048_576,
      totalProcessedScope: "run",
    });
    expect(completedDetail.usage).toContainEqual(
      expect.objectContaining({ turnId: turn.id, usedTokens: 24 }),
    );
    expect(completedDetail.messages).toContainEqual(
      expect.objectContaining({
        turnId: turn.id,
        role: "assistant",
        content: "Kimi runtime lifecycle complete.",
      }),
    );
    expect(JSON.stringify(completedDetail)).not.toContain(SECRET_VALUE);

    client.socket.close();
    sockets.splice(sockets.indexOf(client.socket), 1);
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);

    const restarted = await startRuntime({
      dataDirectory,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      kimiClaudeProfiles: [profile],
      backendCredentials,
      agentHarnessRegistry: registry,
    });
    runtimes.push(restarted);
    const reloadedClient = await connect(restarted.websocketUrl);
    sockets.push(reloadedClient.socket);
    const reloadedWelcome = await reloadedClient.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    const reloadedConversation = reloadedWelcome.snapshot.conversations.find(
      ({ id }) => id === conversation.id,
    )!;
    expect(reloadedConversation.modelSelection).toEqual(reasoningSelection);
    expect(reloadedConversation.latestTurn?.modelSelection)
      .toEqual(reasoningSelection);
    expect(modelSelectionIdentityLabel(reloadedConversation.latestTurn!.modelSelection))
      .toBe("Claude harness · Kimi · K3");
    const reloadedDetail = await detail(
      reloadedClient.socket,
      reloadedClient.events,
      conversation.id,
    );
    expect(reloadedDetail.agentTurns[0]?.modelSelection)
      .toEqual(reasoningSelection);
    expect(JSON.stringify(reloadedWelcome.snapshot)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(reloadedDetail)).not.toContain(SECRET_VALUE);
  });
});
