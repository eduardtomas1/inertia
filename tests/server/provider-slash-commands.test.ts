// @inertia-test-suite portable
import type { Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import type { ClientCommand, ProviderSlashCommand, ServerEvent } from "../../src/shared/contracts";
import {
  CLAUDE_COMMAND_FAILURE_TTL_MS,
  ProviderCommandCatalog,
} from "../../src/server/provider/provider-command-catalog";
import { readClaudeAgentSdkMetadata } from "../../src/server/provider/claude-agent-sdk-metadata";
import { CLAUDE_ISOLATED_SKILL_PLUGIN_NAME } from "../../src/server/provider/claude-skill-plugin";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import {
  isolatedProviderConversationId,
  providerRunTerminal,
  ProviderRuntimeError,
  type ProviderRunInput,
} from "../../src/server/provider/contracts";
import { CURSOR_ACP_CAPABILITIES } from "../../src/server/provider/cursor-acp-harness";
import { ProviderInstallationAdmissionError } from "../../src/server/provider/installation-lease";
import {
  acpSlashCommands,
  MAX_PROVIDER_SLASH_COMMANDS,
  providerSlashCommands,
} from "../../src/server/provider/provider-slash-commands";
import { AgentWorkflowController } from "../../src/server/runtime/agent-workflow-controller";
import { createAgentWorkflowCommandHandler } from "../../src/server/runtime/commands/agent-workflow-commands";
import type { RuntimeStore } from "../../src/server/database";
import { AgentHarnessRegistry, type AgentHarness, ProviderManager } from "../../src/server/providers";
import { nativeProviderRunFields } from "./model-route-fixture";

vi.mock("../../src/server/environment", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/environment")>(),
  providerEnvironment: vi.fn(async () => ({ env: {}, pathEntries: [] })),
}));

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER_CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";

function command(name: string, description = `${name} command`, argumentHint = ""): SlashCommand {
  return { name, description, argumentHint };
}

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function authority(releaseResult = true) {
  return {
    acquire: vi.fn(() => ({ fixture: "admission" }) as never),
    operationIdentity: vi.fn(() => "metadata-discovery-op" as never),
    release: vi.fn(() => releaseResult),
    quarantineUnconfirmedCleanup: vi.fn(),
  };
}

function claudeQuery(supportedCommands: () => Promise<unknown>): Query {
  return {
    supportedModels: vi.fn(async () => []),
    supportedCommands,
    close: vi.fn(),
  } as unknown as Query;
}

function claudeCatalog(options: {
  executable?: () => string;
  query?: () => Query;
  releaseResult?: boolean;
  signal?: AbortSignal;
  now?: () => number;
} = {}) {
  const installationAuthority = authority(options.releaseResult);
  const createQuery = vi.fn(options.query ?? (() => claudeQuery(async () => [command("advisor")])));
  const claudeExecutable = vi.fn(async () => options.executable?.() ?? "/fixture/missing/claude");
  const catalog = new ProviderCommandCatalog({
    installationAuthority,
    resolvedCommand: () => undefined,
    claudeExecutable,
    trackAuxiliary: async (operation) => await operation(),
    rememberEnvironment: () => undefined,
    signal: options.signal ?? new AbortController().signal,
    claudeQuery: createQuery,
    ...(options.now ? { now: options.now } : {}),
  });
  return { catalog, createQuery, installationAuthority, claudeExecutable };
}

function acpCatalog(resolved: () => string | undefined = () => "/fixture/cursor-agent") {
  return new ProviderCommandCatalog({
    installationAuthority: authority(),
    resolvedCommand: (providerId) => providerId === "claude" ? undefined : resolved(),
    claudeExecutable: async () => { throw new Error("not used"); },
    trackAuxiliary: async (operation) => await operation(),
    rememberEnvironment: () => undefined,
    signal: new AbortController().signal,
  });
}

describe("provider slash command projection", () => {
  it("keeps commands Claude runs from a prompt and hides the ones Inertia owns or cannot host", () => {
    const projected = providerSlashCommands("claude", [
      command("advisor", "Set the advisor model", "<fable|opus|sonnet|off>"),
      command("code-review"),
      command("compact"),
      command("clear"),
      command("model"),
      command("config"),
      command("init"),
      command("__remote-workflow"),
      command(`${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:fixture-skill`),
      command("anthropic-skills:pdf"),
      command("Advisor"),
      command("two words"),
    ]);
    expect(projected).toEqual([
      { name: "advisor", description: "Set the advisor model", argumentHint: "<fable|opus|sonnet|off>" },
      { name: "anthropic-skills:pdf", description: "anthropic-skills:pdf command", argumentHint: null },
      { name: "code-review", description: "code-review command", argumentHint: null },
    ]);
  });

  it("bounds the list and strips control characters from provider text", () => {
    const many = Array.from({ length: MAX_PROVIDER_SLASH_COMMANDS + 20 }, (_, index) => command(`cmd-${index}`));
    expect(providerSlashCommands("claude", many)).toHaveLength(MAX_PROVIDER_SLASH_COMMANDS);
    const [projected] = providerSlashCommands("claude", [
      command("review", `Line one\n\u0007line two${"x".repeat(400)}`, "<file>\t[focus]"),
    ]);
    expect(projected?.description.startsWith("Line one line two")).toBe(true);
    expect(projected?.description).toHaveLength(300);
    expect(projected?.argumentHint).toBe("<file> [focus]");
  });

  it("replaces C1 controls and removes bidi and zero-width characters", () => {
    const [projected] = providerSlashCommands("cursor", [{
      name: "review",
      description: "safe\u0085next\u009bend ‮evil‬ ⁦iso⁩ ‎mark‏ ؜arabic",
      argumentHint: "﻿<​file‍>⁠",
    }]);
    expect(projected).toEqual({
      name: "review",
      description: "safe next end evil iso mark arabic",
      argumentHint: "<file>",
    });
  });

  it("removes tag characters, soft hyphens, fillers and interlinear annotation marks", () => {
    const [projected] = providerSlashCommands("grok", [{
      name: "review",
      description: "vis\u{E0068}\u{E0069}\u{E0064}ible­ sh͏y ᅟᅠㅤﾠfill ᠎mongolian ￹a￺b￻",
      argumentHint: "\u{E0001}<file>\u{E007F}",
    }]);
    expect(projected).toEqual({
      name: "review",
      description: "visible shy fill mongolian ab",
      argumentHint: "<file>",
    });
  });

  it("truncates by code point without splitting a surrogate pair and drops lone surrogates", () => {
    const [projected] = providerSlashCommands("kimi", [{
      name: "review",
      description: `${"x".repeat(299)}\u{1F600}\u{1F600}`,
      argumentHint: `${"a".repeat(118)}\uD800\u{1F642}\u{1F642}`,
    }]);
    expect([...projected!.description]).toHaveLength(300);
    expect(projected!.description.endsWith("x\u{1F600}")).toBe(true);
    expect([...projected!.argumentHint!]).toHaveLength(120);
    expect(projected!.argumentHint!.endsWith("\u{1F642}\u{1F642}")).toBe(true);
    expect(LONE_SURROGATE.test(projected!.description)).toBe(false);
    expect(LONE_SURROGATE.test(projected!.argumentHint!)).toBe(false);
  });

  it("advertises nothing for providers that cannot run commands from prompt text", () => {
    for (const providerId of ["codex", "opencode", "antigravity"] as const) {
      expect(providerSlashCommands(providerId, [command("review")])).toEqual([]);
    }
  });

  it("maps ACP available commands with their input hint", () => {
    expect(acpSlashCommands("cursor", [
      { name: "review", description: "Review the diff", input: { hint: "<focus>" } },
      { name: "/summarize", description: "Summarize", input: null },
      { name: "plan", description: "Inertia owns plan mode" },
    ])).toEqual([{ name: "review", description: "Review the diff", argumentHint: "<focus>" }]);
    expect(acpSlashCommands("kimi", [{ name: "/init", description: "Write AGENTS.md" }]))
      .toEqual([{ name: "init", description: "Write AGENTS.md", argumentHint: null }]);
  });
});

describe("Claude command discovery", () => {
  const read = async (supportedCommands: () => Promise<unknown>) => await readClaudeAgentSdkMetadata(
    "/fixture/claude",
    {},
    "/fixture",
    5_000,
    () => claudeQuery(supportedCommands),
    ["commands"],
  );

  it("reads Claude's commands through the metadata probe without asking for models", async () => {
    const supportedModels = vi.fn(async () => []);
    const query = {
      supportedModels,
      supportedCommands: async () => [command("advisor", "Set the advisor model", "<model>"), command("clear"), command("init")],
      close: vi.fn(),
    } as unknown as Query;
    await expect(readClaudeAgentSdkMetadata("/fixture/claude", {}, "/fixture", 5_000, () => query, ["commands"]))
      .resolves.toEqual({ commands: [{ name: "advisor", description: "Set the advisor model", argumentHint: "<model>" }] });
    expect(supportedModels).not.toHaveBeenCalled();
  });

  it("reports no commands field when Claude's command read fails or is not a list", async () => {
    await expect(read(async () => { throw new Error("control request failed"); })).resolves.toEqual({});
    for (const malformed of [null, {}, "advisor", 3, { length: 1, 0: command("advisor") }]) {
      await expect(read(async () => malformed)).resolves.toEqual({});
    }
  });

  it("skips entries of the wrong shape inside a reported list", async () => {
    await expect(read(async () => [
      null,
      3,
      "advisor",
      [command("nested")],
      { name: 5, description: "numeric name" },
      { description: "missing name" },
      { name: "review", description: 7, argumentHint: { hint: "<x>" } },
      command("advisor", "Set the advisor model", "<model>"),
    ])).resolves.toEqual({
      commands: [
        { name: "advisor", description: "Set the advisor model", argumentHint: "<model>" },
        { name: "review", description: "", argumentHint: null },
      ],
    });
  });
});

describe("provider command catalog", () => {
  it("caches Claude's list per resolved executable until the TTL expires", async () => {
    let now = 1_000;
    let executable = "/fixture/missing/claude";
    const { catalog, createQuery, installationAuthority } = claudeCatalog({
      executable: () => executable,
      now: () => now,
    });
    const advisor = { name: "advisor", description: "advisor command", argumentHint: null };
    await expect(catalog.list({ providerId: "claude", cwd: "/project-a", conversationId: CONVERSATION })).resolves.toEqual([advisor]);
    await expect(catalog.list({ providerId: "claude", cwd: "/project-b", conversationId: null })).resolves.toEqual([advisor]);
    expect(createQuery).toHaveBeenCalledTimes(1);
    executable = "/fixture/missing/updated/claude";
    await catalog.list({ providerId: "claude", cwd: "/project-a", conversationId: CONVERSATION });
    expect(createQuery).toHaveBeenCalledTimes(2);
    executable = "/fixture/missing/claude";
    now += 30 * 60 * 1_000 - 1;
    await catalog.list({ providerId: "claude", cwd: "/project-a", conversationId: CONVERSATION });
    expect(createQuery).toHaveBeenCalledTimes(2);
    now += 1;
    await catalog.list({ providerId: "claude", cwd: "/project-a", conversationId: CONVERSATION });
    expect(createQuery).toHaveBeenCalledTimes(3);
    expect(installationAuthority.acquire).toHaveBeenCalledTimes(3);
    expect(installationAuthority.release).toHaveBeenCalledTimes(3);
  });

  it("shares one in-flight Claude discovery and forgets it when cancelled", async () => {
    const lifetime = new AbortController();
    const { catalog, createQuery, installationAuthority } = claudeCatalog({
      signal: lifetime.signal,
      query: () => claudeQuery(async () => await new Promise<never>(() => undefined)),
    });
    const scope = { providerId: "claude", cwd: "/project-a", conversationId: CONVERSATION } as const;
    const first = catalog.list(scope);
    const second = catalog.list(scope);
    await vi.waitFor(() => expect(createQuery).toHaveBeenCalledTimes(1));
    lifetime.abort();
    await expect(first).rejects.toThrow("Claude metadata discovery was cancelled.");
    await expect(second).rejects.toThrow("Claude metadata discovery was cancelled.");
    expect(installationAuthority.release).toHaveBeenCalledTimes(1);
    await expect(catalog.list(scope)).rejects.toThrow("Claude metadata discovery was cancelled.");
    expect(installationAuthority.acquire).toHaveBeenCalledTimes(2);
  });

  it("remembers a failed Claude read for a minute instead of starting a discovery on every request", async () => {
    let now = 5_000;
    let reported: unknown = null;
    const failing = claudeCatalog({ now: () => now, query: () => claudeQuery(async () => reported) });
    const scope = { providerId: "claude", cwd: "/project-a", conversationId: null } as const;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(failing.catalog.list(scope)).rejects.toThrow("Claude did not report its slash commands.");
    }
    expect(failing.createQuery).toHaveBeenCalledTimes(1);
    expect(failing.installationAuthority.acquire).toHaveBeenCalledTimes(1);
    now += CLAUDE_COMMAND_FAILURE_TTL_MS - 1;
    await expect(failing.catalog.list(scope)).rejects.toThrow("Claude did not report its slash commands.");
    expect(failing.createQuery).toHaveBeenCalledTimes(1);
    now += 1;
    reported = [command("advisor")];
    await expect(failing.catalog.list(scope)).resolves.toEqual([{ name: "advisor", description: "advisor command", argumentHint: null }]);
    expect(failing.createQuery).toHaveBeenCalledTimes(2);
  });

  it("forgets a remembered Claude failure on refresh or when the executable changes", async () => {
    let executable = "/fixture/missing/claude";
    const failing = claudeCatalog({ executable: () => executable, query: () => claudeQuery(async () => null) });
    const scope = { providerId: "claude", cwd: "/project-a", conversationId: null } as const;
    await expect(failing.catalog.list(scope)).rejects.toThrow("Claude did not report its slash commands.");
    failing.catalog.forgetFailures("cursor");
    await expect(failing.catalog.list(scope)).rejects.toThrow("Claude did not report its slash commands.");
    expect(failing.createQuery).toHaveBeenCalledTimes(1);
    failing.catalog.forgetFailures("claude");
    await expect(failing.catalog.list(scope)).rejects.toThrow("Claude did not report its slash commands.");
    expect(failing.createQuery).toHaveBeenCalledTimes(2);
    executable = "/fixture/missing/updated/claude";
    await expect(failing.catalog.list(scope)).rejects.toThrow("Claude did not report its slash commands.");
    expect(failing.createQuery).toHaveBeenCalledTimes(3);
  });

  it("never remembers an integrity failure and reports it on every request", async () => {
    const scope = { providerId: "claude", cwd: "/project-a", conversationId: null } as const;
    const corrupt = claudeCatalog({ releaseResult: false });
    await expect(corrupt.catalog.list(scope)).rejects.toMatchObject({ code: "lifecycle_corruption" });
    await expect(corrupt.catalog.list(scope)).rejects.toMatchObject({ code: "lifecycle_corruption" });
    expect(corrupt.createQuery).toHaveBeenCalledTimes(2);
    const unconfirmed = Object.assign(new Error("Claude metadata process tree was not confirmed stopped."), {
      code: "process-tree-termination-unconfirmed",
    });
    const orphaned = claudeCatalog({ query: () => { throw unconfirmed; } });
    await expect(orphaned.catalog.list(scope)).rejects.toMatchObject({ code: "process-tree-termination-unconfirmed" });
    await expect(orphaned.catalog.list(scope)).rejects.toMatchObject({ code: "process-tree-termination-unconfirmed" });
    expect(orphaned.installationAuthority.acquire).toHaveBeenCalledTimes(2);
    expect(orphaned.installationAuthority.quarantineUnconfirmedCleanup).toHaveBeenCalledTimes(2);
    expect(orphaned.installationAuthority.release).not.toHaveBeenCalled();
  });

  it("keeps ACP command lists per conversation and workspace, never across projects", async () => {
    let cursorExecutable = "/fixture/cursor-agent";
    const catalog = acpCatalog(() => cursorExecutable);
    const review = { name: "review", description: "Review the diff", argumentHint: null };
    const deploy = { name: "deploy", description: "Project B only", argumentHint: null };
    await expect(catalog.list({ providerId: "cursor", cwd: "/project-a", conversationId: CONVERSATION })).resolves.toEqual([]);
    catalog.learn({ providerId: "cursor", cwd: "/project-a", conversationId: CONVERSATION }, [review]);
    catalog.learn({ providerId: "cursor", cwd: "/project-b", conversationId: OTHER_CONVERSATION }, [deploy]);
    catalog.learn({ providerId: "codex", cwd: "/project-a", conversationId: CONVERSATION }, [review]);
    await expect(catalog.list({ providerId: "cursor", cwd: "/project-a", conversationId: CONVERSATION })).resolves.toEqual([review]);
    await expect(catalog.list({ providerId: "cursor", cwd: "/project-b", conversationId: OTHER_CONVERSATION })).resolves.toEqual([deploy]);
    await expect(catalog.list({ providerId: "cursor", cwd: "/project-b", conversationId: null })).resolves.toEqual([deploy]);
    await expect(catalog.list({ providerId: "cursor", cwd: "/project-c", conversationId: null })).resolves.toEqual([]);
    await expect(catalog.list({ providerId: "kimi", cwd: "/project-a", conversationId: CONVERSATION })).resolves.toEqual([]);
    await expect(catalog.list({ providerId: "codex", cwd: "/project-a", conversationId: CONVERSATION })).resolves.toEqual([]);
    cursorExecutable = "/fixture/updated/cursor-agent";
    await expect(catalog.list({ providerId: "cursor", cwd: "/project-a", conversationId: CONVERSATION })).resolves.toEqual([]);
  });

  it("prefers a conversation's own list over its workspace's latest list", async () => {
    const catalog = acpCatalog();
    const first = { name: "first", description: "", argumentHint: null };
    const second = { name: "second", description: "", argumentHint: null };
    catalog.learn({ providerId: "kimi", cwd: "/project-a", conversationId: CONVERSATION }, [first]);
    catalog.learn({ providerId: "kimi", cwd: "/project-a", conversationId: OTHER_CONVERSATION }, [second]);
    await expect(catalog.list({ providerId: "kimi", cwd: "/project-a", conversationId: CONVERSATION })).resolves.toEqual([first]);
    await expect(catalog.list({ providerId: "kimi", cwd: "/project-a", conversationId: OTHER_CONVERSATION })).resolves.toEqual([second]);
    await expect(catalog.list({ providerId: "kimi", cwd: "/project-a", conversationId: null })).resolves.toEqual([second]);
    await expect(catalog.list({ providerId: "kimi", cwd: "/project-b", conversationId: CONVERSATION })).resolves.toEqual([]);
  });
});

type ConversationFixture = {
  id: string;
  projectId: string;
  providerId: "claude" | "cursor" | "codex" | "grok";
  modelSelection: { harnessId: string };
};

function controller(
  providerCommands: (scope: { providerId: string; cwd: string; conversationId: string | null }) => Promise<ProviderSlashCommand[]>,
  conversations: readonly ConversationFixture[] = [],
) {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const store = {
    conversation: vi.fn((id: string) => {
      const conversation = byId.get(id);
      if (!conversation) throw new Error("Conversation not found.");
      return conversation;
    }),
    conversationPath: vi.fn((id: string) => `/workspace/${id}`),
    projectPath: vi.fn((projectId: string) => {
      if (projectId !== PROJECT) throw new Error("Project not found.");
      return "/workspace/project";
    }),
  } as unknown as RuntimeStore;
  const spy = vi.fn(providerCommands);
  const providers = {
    codexControlContext: vi.fn(),
    claudeSkills: vi.fn(),
    providerCommands: spy,
  } as unknown as ProviderManager;
  return { workflows: new AgentWorkflowController(store, providers), providerCommands: spy };
}

const review = { name: "review", description: "Review the diff", argumentHint: null };

describe("provider command listing", () => {
  it("resolves provider and workspace from the conversation, not from the client", async () => {
    const { workflows, providerCommands } = controller(async () => [review], [
      { id: CONVERSATION, projectId: PROJECT, providerId: "cursor", modelSelection: { harnessId: "cursor-acp" } },
    ]);
    await expect(workflows.listProviderCommands({ conversationId: CONVERSATION }))
      .resolves.toEqual({ conversationId: CONVERSATION, providerId: "cursor", commands: [review] });
    expect(providerCommands).toHaveBeenCalledWith({
      providerId: "cursor",
      cwd: `/workspace/${CONVERSATION}`,
      conversationId: CONVERSATION,
    });
    await expect(workflows.listProviderCommands({ conversationId: OTHER_CONVERSATION }))
      .rejects.toThrow("Conversation not found.");
  });

  it("lists commands for a Grok conversation on its native harness", async () => {
    const { workflows, providerCommands } = controller(async () => [review], [
      { id: CONVERSATION, projectId: PROJECT, providerId: "grok", modelSelection: { harnessId: "grok-acp" } },
    ]);
    await expect(workflows.listProviderCommands({ conversationId: CONVERSATION }))
      .resolves.toEqual({ conversationId: CONVERSATION, providerId: "grok", commands: [review] });
    expect(providerCommands).toHaveBeenCalledWith({ providerId: "grok", cwd: `/workspace/${CONVERSATION}`, conversationId: CONVERSATION });
  });

  it("lists nothing for a conversation that is not on its provider's native harness", async () => {
    const { workflows, providerCommands } = controller(async () => [review], [
      { id: CONVERSATION, projectId: PROJECT, providerId: "cursor", modelSelection: { harnessId: "cursor-cli" } },
    ]);
    await expect(workflows.listProviderCommands({ conversationId: CONVERSATION }))
      .resolves.toEqual({ conversationId: CONVERSATION, providerId: "cursor", commands: [] });
    expect(providerCommands).not.toHaveBeenCalled();
  });

  it("lists a draft's commands from its project folder without a conversation identity", async () => {
    const { workflows, providerCommands } = controller(async () => [review]);
    await expect(workflows.listProviderCommands({ draftConversationId: CONVERSATION, projectId: PROJECT, providerId: "kimi" }))
      .resolves.toEqual({ conversationId: CONVERSATION, providerId: "kimi", commands: [review] });
    expect(providerCommands).toHaveBeenCalledWith({ providerId: "kimi", cwd: "/workspace/project", conversationId: null });
  });

  it("returns no commands when the provider is unavailable or discovery fails", async () => {
    const claude = [{ id: CONVERSATION, projectId: PROJECT, providerId: "claude", modelSelection: { harnessId: "claude-agent-sdk" } }] as const;
    for (const failure of [
      new ProviderRuntimeError("invalid_input", "Claude CLI is not installed."),
      new ProviderInstallationAdmissionError("Claude is updating.", []),
      new Error("Claude metadata discovery timed out."),
    ]) {
      const { workflows } = controller(async () => { throw failure; }, claude);
      await expect(workflows.listProviderCommands({ conversationId: CONVERSATION }))
        .resolves.toEqual({ conversationId: CONVERSATION, providerId: "claude", commands: [] });
    }
  });

  it("propagates installation-lock corruption and unconfirmed process cleanup", async () => {
    const claude = [{ id: CONVERSATION, projectId: PROJECT, providerId: "claude", modelSelection: { harnessId: "claude-agent-sdk" } }] as const;
    const corruption = new ProviderRuntimeError("lifecycle_corruption", "Claude command discovery could not release exact installation authority.");
    const unconfirmed = Object.assign(new Error("Claude metadata process tree was not confirmed stopped."), {
      code: "process-tree-termination-unconfirmed",
    });
    for (const failure of [corruption, unconfirmed]) {
      const { workflows } = controller(async () => { throw failure; }, claude);
      await expect(workflows.listProviderCommands({ conversationId: CONVERSATION })).rejects.toBe(failure);
    }
  });

  it("answers both payload forms and lets integrity errors reach the request", async () => {
    const sent: ServerEvent[] = [];
    const listProviderCommands = vi.fn(async (target: { conversationId: string } | { draftConversationId: string }) => {
      if ("conversationId" in target && target.conversationId === OTHER_CONVERSATION) {
        throw new ProviderRuntimeError("lifecycle_corruption", "corrupt");
      }
      return {
        conversationId: "conversationId" in target ? target.conversationId : target.draftConversationId,
        providerId: "cursor" as const,
        commands: [review],
      };
    });
    const handler = createAgentWorkflowCommandHandler({
      workflows: { listProviderCommands } as unknown as AgentWorkflowController,
      providerTerminalResumes: { isActive: () => false },
      conversationWork: { reserve: () => true, release: () => undefined },
      broadcast: () => undefined,
      send: (_socket, event) => { sent.push(event); },
    });
    const list = (payload: Extract<ClientCommand, { type: "agent.commands.list" }>["payload"]): ClientCommand => ({
      type: "agent.commands.list",
      requestId: REQUEST,
      payload,
    });
    await expect(handler({} as never, list({ conversationId: CONVERSATION }))).resolves.toBe("handled");
    await expect(handler({} as never, list({ draftConversationId: CONVERSATION, projectId: PROJECT, providerId: "cursor" })))
      .resolves.toBe("handled");
    expect(sent).toEqual([1, 2].map(() => ({
      type: "request.result",
      requestId: REQUEST,
      result: { kind: "agent.commands", conversationId: CONVERSATION, providerId: "cursor", commands: [review] },
    })));
    await expect(handler({} as never, list({ conversationId: OTHER_CONVERSATION }))).rejects.toMatchObject({ code: "lifecycle_corruption" });
    expect(sent).toHaveLength(2);
  });
});

describe("provider command learning from runs", () => {
  it("keys what a run advertised by the run's conversation and workspace", async () => {
    const advertised = new Map<string, unknown[]>();
    const harness = {
      id: "cursor-acp",
      providerId: "cursor",
      capabilities: CURSOR_ACP_CAPABILITIES,
      supports: () => true,
      start: (options: { input: ProviderRunInput; callbacks?: never }) => {
        const emitter = createAgentHarnessEmitter("cursor", options.input.conversationId, options.callbacks, options.input.runId, options.input.turnId);
        emitter.rich({
          type: "metadata",
          metadata: { commands: acpSlashCommands("cursor", advertised.get(options.input.cwd) ?? []) },
          source: "session",
          complete: true,
        });
        return {
          harnessId: "cursor-acp",
          providerId: "cursor",
          cancel: () => undefined,
          result: Promise.resolve({
            ...providerRunTerminal(options.input, "completed"),
            text: "",
            textTruncated: false,
            exitCode: 0,
            signal: null,
            cleanupConfirmed: true,
          }),
        };
      },
    };
    const providers = ProviderManager.createForTests(
      { commands: { cursor: "cursor-agent" }, conversationProviderGate: () => undefined },
      new AgentHarnessRegistry([harness as unknown as AgentHarness]),
    );
    const run = async (conversationId: string, cwd: string, runId: string) => await providers.run({
      ...nativeProviderRunFields("cursor"),
      conversationId,
      runId,
      turnId: runId,
      cwd,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
    });
    advertised.set("/project-a", [{ name: "review", description: "Project A review" }]);
    advertised.set("/project-b", [{ name: "deploy", description: "Project B deploy" }]);
    advertised.set("/project-c", [{ name: "secret", description: "Isolated task only" }]);
    await run(CONVERSATION, "/project-a", "55555555-5555-4555-8555-555555555555");
    await run(OTHER_CONVERSATION, "/project-b", "66666666-6666-4666-8666-666666666666");
    await run(isolatedProviderConversationId(CONVERSATION, "task-1"), "/project-c", "77777777-7777-4777-8777-777777777777");
    const listed = async (cwd: string, conversationId: string | null) =>
      (await providers.providerCommands({ providerId: "cursor", cwd, conversationId })).map(({ name }) => name);
    expect(await listed("/project-a", CONVERSATION)).toEqual(["review"]);
    expect(await listed("/project-b", OTHER_CONVERSATION)).toEqual(["deploy"]);
    expect(await listed("/project-b", CONVERSATION)).toEqual(["deploy"]);
    expect(await listed("/project-a", OTHER_CONVERSATION)).toEqual(["review"]);
    expect(await listed("/project-c", null)).toEqual([]);
    expect(await listed("/project-d", null)).toEqual([]);
  });
});
