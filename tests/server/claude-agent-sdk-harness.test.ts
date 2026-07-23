import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  CanUseTool,
  Options as ClaudeOptions,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness, readClaudeAgentSdkModels } from "../../src/server/provider/claude-agent-sdk-harness";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";

describe("Claude Agent SDK harness", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("uses structured prompts and bridges native approvals, questions, plans, thinking, and usage", async () => {
    const root = portableFixtureRoot("Claude SDK");
    roots.push(root);
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let capturedMessage: SDKUserMessage | undefined;
    let capturedOptions: ClaudeOptions | undefined;
    const permissionResults: PermissionResult[] = [];

    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt, options }) => {
        capturedOptions = options;
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          capturedMessage = (await iterator.next()).value;
          const canUseTool = options?.canUseTool as CanUseTool;
          const approval = await canUseTool("Bash", { command: "npm test" }, {
            signal: new AbortController().signal,
            title: "Run tests",
            description: "Execute the project test suite",
            toolUseID: "tool-1",
            requestId: "permission-1",
          });
          permissionResults.push(approval!);
          const question = await canUseTool("AskUserQuestion", {
            questions: [{ header: "Scope", question: "Which scope?", options: [{ label: "Focused", description: "Only this package" }] }],
          }, { signal: new AbortController().signal, toolUseID: "tool-2", requestId: "permission-2" });
          permissionResults.push(question!);
          permissionResults.push((await canUseTool("ExitPlanMode", { plan: "- Inspect\n- Implement" }, {
            signal: new AbortController().signal,
            toolUseID: "tool-3",
            requestId: "permission-3",
          }))!);
          yield {
            type: "stream_event",
            session_id: "33333333-3333-4333-8333-333333333333",
            event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking constraints" } },
          } as unknown as SDKMessage;
          yield {
            type: "stream_event",
            session_id: "33333333-3333-4333-8333-333333333333",
            event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude response" } },
          } as unknown as SDKMessage;
          yield {
            type: "result",
            subtype: "success",
            session_id: "33333333-3333-4333-8333-333333333333",
            result: "Claude response",
          usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
            modelUsage: { sonnet: { contextWindow: 200_000 } },
          } as unknown as SDKMessage;
        })();
        return Object.assign(stream, {
          interrupt: async () => undefined,
          close: () => undefined,
          supportedModels: async () => [{
            value: "sonnet",
            resolvedModel: "claude-sonnet-test",
            displayName: "Sonnet",
            description: "Balanced model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "high"],
          }],
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            rate_limits_available: true,
            rate_limits: { five_hour: { utilization: 30, resets_at: "2026-07-22T15:00:00.000Z" } },
          }),
          getContextUsage: async () => ({ totalTokens: 75, maxTokens: 200_000, isAutoCompactEnabled: true }) as never,
        }) as unknown as Query;
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([harness]),
    );
    const approvals: string[] = [];
    const questions: string[] = [];
    const questionIds: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usages: Array<number | null> = [];
    const usageDetails: Array<Record<string, unknown>> = [];
    const metadata: Array<{ models: string[]; rateLimits: string[] }> = [];

    const result = await manager.run({
      providerId: "claude",
      conversationId: "claude-rich",
      cwd: root,
      prompt: "Inspect this image",
      interactionMode: "build",
      access: "supervised",
      model: "sonnet",
      reasoningEffort: "high",
      imagePaths: [imagePath],
    }, {
      onApproval: (event) => {
        approvals.push(event.request.title);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onInput: (event) => {
        const question = event.request.questions[0]!;
        questions.push(question.question);
        questionIds.push(question.id);
        expect(question.id).not.toBe(question.question);
        expect(manager.respondToInput(event.conversationId, event.request.requestId, {
          [question.id]: [question.options[0]!.id],
        })).toBe(true);
      },
      onPlan: (event) => plans.push(...event.steps.map((step) => step.step)),
      onReasoning: (event) => reasoning.push(event.text),
      onUsage: (event) => {
        usages.push(event.usage.usedTokens);
        usageDetails.push(event.usage);
      },
      onMetadata: (event) => metadata.push({
        models: event.metadata.models?.map((model) => model.id) ?? [],
        rateLimits: event.metadata.rateLimits?.map((limit) => limit.id) ?? [],
      }),
    });

    expect(result).toMatchObject({ status: "completed", text: "Claude response", sessionId: "33333333-3333-4333-8333-333333333333" });
    expect(capturedOptions).toMatchObject({
      pathToClaudeCodeExecutable: "/fake/claude",
      permissionMode: "default",
      includePartialMessages: true,
      model: "sonnet",
      effort: "high",
    });
    const content = capturedMessage?.message.content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } });
    expect(content[1]).toEqual({ type: "text", text: "Inspect this image" });
    expect(approvals).toEqual(["Run tests"]);
    expect(questions).toEqual(["Which scope?"]);
    expect(questionIds).toEqual(["tool-2:question:1"]);
    expect(plans).toEqual(["Inspect", "Implement"]);
    expect(reasoning).toEqual(["Checking constraints"]);
    expect(usages).toEqual([75]);
    expect(usageDetails).toEqual([expect.objectContaining({
      usedTokens: 75,
      totalProcessedTokens: 165,
      totalProcessedScope: "run",
      maxTokens: 200_000,
      inputTokens: 135,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      compactsAutomatically: true,
    })]);
    expect(metadata).toEqual(expect.arrayContaining([
      { models: ["sonnet"], rateLimits: [] },
      { models: [], rateLimits: ["claude:five_hour"] },
    ]));
    expect(manager.cachedMetadata("claude")).toMatchObject({
      models: [expect.objectContaining({ id: "sonnet" })],
      rateLimits: [expect.objectContaining({ id: "claude:five_hour", usedPercent: 30 })],
    });
    expect(permissionResults).toMatchObject([
      { behavior: "allow", updatedInput: { command: "npm test" } },
      { behavior: "allow", updatedInput: { answers: { "Which scope?": "Focused" } } },
      { behavior: "deny" },
    ]);
  });

  it("maps the SDK's authoritative model inventory without sending a prompt", async () => {
    let promptWasRead = false;
    const models = await readClaudeAgentSdkModels("/fake/claude", {}, "/workspace", 1_000, ({ prompt }) => {
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        promptWasRead = true;
        for await (const _message of prompt as AsyncIterable<SDKUserMessage>) { /* No prompt should be produced. */ }
      })();
      return Object.assign(stream, {
        supportedModels: async () => [{
          value: "sonnet",
          resolvedModel: "claude-sonnet-test",
          displayName: "Sonnet",
          description: "Balanced model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        }],
        interrupt: async () => undefined,
        close: () => undefined,
      }) as unknown as Query;
    });

    expect(promptWasRead).toBe(false);
    expect(models).toEqual([expect.objectContaining({
      id: "sonnet",
      label: "Sonnet",
      isDefault: true,
      inputModalities: ["text", "image"],
      defaultReasoningEffort: "high",
      reasoningOptions: [expect.objectContaining({ value: "low" }), expect.objectContaining({ value: "high" })],
    })]);
  });

  it("resumes through the SDK contract and interrupts without leaving an active run", async () => {
    const root = portableFixtureRoot("Claude SDK cancellation");
    roots.push(root);
    let capturedOptions: ClaudeOptions | undefined;
    let release!: () => void;
    const interrupted = new Promise<void>((resolve) => { release = resolve; });
    let interruptCalls = 0;
    let closeCalls = 0;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        capturedOptions = options;
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          await interrupted;
          yield {
            type: "result",
            subtype: "success",
            session_id: "66666666-6666-4666-8666-666666666666",
            result: "late result",
            usage: { input_tokens: 1, output_tokens: 1 },
          } as unknown as SDKMessage;
        })();
        return Object.assign(stream, {
          supportedModels: async () => [],
          interrupt: async () => { interruptCalls += 1; release(); },
          close: () => { closeCalls += 1; release(); },
        }) as unknown as Query;
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([harness]),
    );
    let running!: () => void;
    const started = new Promise<void>((resolve) => { running = resolve; });
    const statuses: string[] = [];
    const result = manager.run({
      providerId: "claude",
      conversationId: "claude-cancel",
      cwd: root,
      prompt: "Wait for cancellation",
      interactionMode: "build",
      access: "supervised",
      sessionId: "resume-session",
    }, {
      onStatus: ({ status }) => { statuses.push(status); if (status === "running") running(); },
    });

    await started;
    expect(manager.cancel("claude-cancel")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(capturedOptions?.resume).toBe("resume-session");
    expect(interruptCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(statuses).toEqual(["starting", "running", "cancelling", "cancelled"]);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("fails closed on SDK startup errors and unsupported image input", async () => {
    const root = portableFixtureRoot("Claude SDK failures");
    roots.push(root);
    const unsupportedImage = join(root, "reference.txt");
    writeFileSync(unsupportedImage, "not an image");
    let queryCalls = 0;
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => {
        queryCalls += 1;
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          throw new Error("SDK transport unavailable");
        })();
        return Object.assign(stream, {
          supportedModels: async () => [],
          interrupt: async () => undefined,
          close: () => undefined,
        }) as unknown as Query;
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );

    await expect(manager.run({
      providerId: "claude",
      conversationId: "claude-sdk-error",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    })).resolves.toMatchObject({ status: "failed", error: "SDK transport unavailable" });
    await expect(manager.run({
      providerId: "claude",
      conversationId: "claude-bad-image",
      cwd: root,
      prompt: "Inspect",
      interactionMode: "build",
      access: "supervised",
      imagePaths: [unsupportedImage],
    })).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("image type") });
    expect(queryCalls).toBe(1);
    expect(manager.activeConversationIds()).toEqual([]);
  });
});
