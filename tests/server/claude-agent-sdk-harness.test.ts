import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("Claude Agent SDK harness", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it("uses structured prompts and bridges native approvals, questions, plans, thinking, and usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-claude-sdk-"));
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
            usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 10 },
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
          getContextUsage: async () => ({}) as never,
        }) as unknown as Query;
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([harness]),
    );
    const approvals: string[] = [];
    const questions: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usages: number[] = [];
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
        questions.push(event.request.questions[0]!.question);
        expect(manager.respondToInput(event.conversationId, event.request.requestId, { "Which scope?": ["Focused"] })).toBe(true);
      },
      onPlan: (event) => plans.push(...event.steps.map((step) => step.step)),
      onReasoning: (event) => reasoning.push(event.text),
      onUsage: (event) => usages.push(event.usage.usedTokens),
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
    expect(plans).toEqual(["Inspect", "Implement"]);
    expect(reasoning).toEqual(["Checking constraints"]);
    expect(usages).toEqual([120]);
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
});
