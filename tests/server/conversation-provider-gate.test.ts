// @inertia-test-suite portable
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  AgentHarnessRegistry,
  ProviderManager,
  type AgentHarness,
  type ProviderId,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/providers";
import { CODEX_APP_SERVER_HARNESS_CAPABILITIES } from "../../src/server/provider/codex-app-server-harness";
import {
  ProviderRunRefusedError,
  isolatedProviderConversationId,
  providerRunTerminal,
} from "../../src/server/provider/contracts";
import { ConversationProviderChangeError } from "../../src/server/persistence/errors";
import { MIXED_PROVIDER_HISTORY_MESSAGE } from "../../src/shared/continuation-policy";
import { nativeProviderRunFields } from "./model-route-fixture";

const conversationId = "11111111-1111-4111-8111-111111111111";
const sourceRoot = join(__dirname, "../../src");

function input(overrides: Partial<ProviderRunInput> = {}): ProviderRunInput {
  return {
    ...nativeProviderRunFields("codex", "provider-default", ""),
    conversationId,
    runId: "run-1",
    turnId: "turn-1",
    cwd: "/workspace",
    prompt: "Continue this chat",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  } as ProviderRunInput;
}

function recordingHarness(events: string[]): AgentHarness {
  return {
    id: "codex-app-server",
    providerId: "codex",
    capabilities: CODEX_APP_SERVER_HARNESS_CAPABILITIES,
    supports: () => true,
    start: (options) => {
      events.push(`harness:${options.input.conversationId}`);
      return {
        harnessId: "codex-app-server",
        providerId: "codex",
        result: Promise.resolve({
          ...providerRunTerminal(options.input, "completed"),
          text: "",
          textTruncated: false,
          exitCode: 0,
          signal: null,
          cleanupConfirmed: true,
        } as ProviderRunResult),
        cancel: () => undefined,
        extension: {
          kind: "codex-app-server",
          respondToApproval: () => false,
          respondToInput: () => false,
          setGoal: async () => ({
            status: "active",
            objective: "Unused",
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
}

function manager(events: string[], rejection?: string, detectProvider = vi.fn()) {
  const gate = vi.fn((gatedConversationId: string, providerId: ProviderId) => {
    events.push(`gate:${gatedConversationId}:${providerId}`);
    if (rejection) throw new ConversationProviderChangeError(rejection);
  });
  return {
    gate,
    detectProvider,
    providers: ProviderManager.createForTests(
      { conversationProviderGate: gate, detectProvider },
      new AgentHarnessRegistry([recordingHarness(events)]),
    ),
  };
}

function productionSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? productionSources(path)
      : path.endsWith(".ts") ? [path] : [];
  });
}

describe("conversation provider gate", () => {
  it("refuses a conversation run and compaction before the harness starts", () => {
    const events: string[] = [];
    const { providers } = manager(events, MIXED_PROVIDER_HISTORY_MESSAGE);

    expect(() => providers.run(input())).toThrow(ProviderRunRefusedError);
    expect(() => providers.compact(
      input({ runId: "run-2", turnId: "turn-2", sessionId: "thread-1" }),
      "Keep the plan",
    )).toThrow(MIXED_PROVIDER_HISTORY_MESSAGE);

    expect(events).toEqual([`gate:${conversationId}:codex`, `gate:${conversationId}:codex`]);
  });

  it("passes the gate before the harness starts for an allowed conversation", async () => {
    const events: string[] = [];
    const { providers } = manager(events);

    await expect(providers.run(input())).resolves.toMatchObject({ status: "completed" });

    expect(events).toEqual([`gate:${conversationId}:codex`, `harness:${conversationId}`]);
  });

  it("runs isolated review tasks without the conversation gate", async () => {
    const events: string[] = [];
    const { providers, gate } = manager(events, MIXED_PROVIDER_HISTORY_MESSAGE);
    const isolatedId = isolatedProviderConversationId(conversationId, "task-1");

    await expect(providers.run(input({ conversationId: isolatedId }))).resolves.toMatchObject({ status: "completed" });

    expect(gate).not.toHaveBeenCalled();
    expect(events).toEqual([`harness:${isolatedId}`]);
  });

  it("refuses a terminal resume before provider detection", async () => {
    const events: string[] = [];
    const { providers, detectProvider } = manager(events, MIXED_PROVIDER_HISTORY_MESSAGE);

    await expect(providers.terminalResumeLaunch(conversationId, "codex", "thread-1", "/workspace"))
      .rejects.toThrow(MIXED_PROVIDER_HISTORY_MESSAGE);

    expect(detectProvider).not.toHaveBeenCalled();
    expect(events).toEqual([`gate:${conversationId}:codex`]);
  });

  it("requires the gate for production provider managers", () => {
    expect(() => ProviderManager.createProduction({ installationLeases: {} } as never))
      .toThrow("Production ProviderManager construction requires a conversation provider gate.");
  });

  it("creates conversation-scoped provider control clients only behind the gate", () => {
    const sources = productionSources(sourceRoot).map((path) => ({
      path: relative(sourceRoot, path).replaceAll("\\", "/"),
      text: readFileSync(path, "utf8"),
    }));
    const calling = (pattern: RegExp) => sources
      .filter(({ path, text }) => path !== "server/providers.ts" && pattern.test(text))
      .map(({ path }) => path);
    expect(calling(/providers\.codexControlContext\(/u)).toEqual([
      "server/runtime/conversation-provider-contact.ts",
      "server/usage/native.ts",
    ]);
    expect(calling(/providers\.claudeSkills\(/u)).toEqual(["server/runtime/conversation-provider-contact.ts"]);
    const contact = sources.find(({ path }) => path === "server/runtime/conversation-provider-contact.ts")!.text;
    for (const method of ["codexControlContext", "claudeSkills"]) {
      const call = contact.indexOf(`.${method}(`);
      expect(contact.lastIndexOf("assertConversationProvider(", call)).toBeGreaterThan(-1);
    }
    expect(calling(/withCodexControlClient\(/u)).toEqual([
      "server/codex-metadata.ts",
      "server/runtime/agent-workflow-controller.ts",
      "server/usage/native.ts",
    ]);
  });

  it("starts provider harnesses only behind the gate", () => {
    const sources = productionSources(sourceRoot).map((path) => ({
      path: relative(sourceRoot, path).replaceAll("\\", "/"),
      text: readFileSync(path, "utf8"),
    }));
    const constructing = sources.filter(({ text }) => text.includes("new ProviderRunCoordinator("));
    const resolvingForStart = sources.filter(({ text }) => /harnessRegistry\.resolve\(input\);/u.test(text));
    expect(constructing.map(({ path }) => path)).toEqual(["server/providers.ts"]);
    expect(resolvingForStart.map(({ path }) => path)).toEqual(["server/provider/run-coordinator.ts"]);
    const coordinator = resolvingForStart[0]!.text;
    const run = coordinator.slice(coordinator.indexOf("\n  run("));
    expect(run.indexOf("conversationProviderGate")).toBeGreaterThan(0);
    expect(run.indexOf("conversationProviderGate")).toBeLessThan(run.indexOf("harnessRegistry.resolve(input)"));
    expect(run.indexOf("harnessRegistry.resolve(input)")).toBeLessThan(run.indexOf("harness.start("));
  });
});
