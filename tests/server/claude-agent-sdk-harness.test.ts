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

import {
  claudeHarnessBackendCompatibility,
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
  modelBackendProfileForClaudeProfile,
} from "../../src/shared/claude-backend-profiles";
import { continuationIdentityForSelection } from "../../src/shared/model-routing";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  claudeQuestions,
  createClaudeAgentSdkHarness,
  readClaudeAgentSdkModels,
  readClaudeAgentSdkSkills,
} from "../../src/server/provider/claude-agent-sdk-harness";
import {
  claudeBackendProfileRegistrations,
  createClaudeBackendLaunchResolver,
} from "../../src/server/runtime/backends/claude-compatible-adapter";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import {
  claudeBackgroundTasks,
  claudeSessionState,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude Agent SDK harness", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("preserves the SDK question contract without silently truncating prompts", () => {
    const questions = Array.from({ length: 4 }, (_, questionIndex) => ({
      header: `Question ${questionIndex + 1}`,
      question: `Prompt ${questionIndex + 1}`,
      options: Array.from({ length: 4 }, (_, optionIndex) => ({
        label: `Option ${optionIndex + 1}`,
        description: `Description ${optionIndex + 1}`,
      })),
    }));

    const request = claudeQuestions("request-1", "tool-1", { questions });
    expect(request.questions).toHaveLength(4);
    expect(request.questions[3]).toMatchObject({
      id: "tool-1:question:4",
      question: "Prompt 4",
      options: [{ id: "option-1" }, { id: "option-2" }, { id: "option-3" }, { id: "option-4" }],
    });
    expect(() => claudeQuestions("request-2", "tool-2", {
      questions: [...questions, questions[0]],
    })).toThrow("more than 4 questions");
    expect(() => claudeQuestions("request-3", "tool-3", {
      questions: [{
        ...questions[0],
        options: [...questions[0]!.options, questions[0]!.options[0]],
      }],
    })).toThrow("more than 4 options");
    expect(() => claudeQuestions("request-empty", "tool-empty", {
      questions: [],
    })).toThrow("empty question request");
    expect(() => claudeQuestions("request-4", "tool-4", {
      questions: [questions[0], null],
    })).toThrow("invalid question at position 2");
    expect(() => claudeQuestions("request-5", "tool-5", {
      questions: [
        questions[0],
        { ...questions[1], question: questions[0]!.question },
      ],
    })).toThrow("duplicate question prompts");
    expect(() => claudeQuestions("request-6", "tool-6", {
      questions: [{
        ...questions[0],
        question: "x".repeat(1024 * 1024 + 1),
      }],
    })).toThrow("invalid question 1");
    expect(() => claudeQuestions("request-7", "tool-7", {
      questions: [{
        ...questions[0],
        options: [
          questions[0]!.options[0],
          {
            ...questions[0]!.options[1],
            label: questions[0]!.options[0]!.label,
          },
        ],
      }],
    })).toThrow("duplicate option label");
  });

  it("fails and cleans up a run that floods bounded provider events", async () => {
    const root = portableFixtureRoot("Claude SDK event flood");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          for (let index = 0; index < 8_193; index += 1) {
            yield claudeSystem("status", { index });
          }
        })(),
      ),
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-event-flood",
      cwd: root,
      prompt: "Flood",
      interactionMode: "build",
      access: "full",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Claude exceeded the bounded event budget for this run.",
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });

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
            type: "assistant",
            session_id: "33333333-3333-4333-8333-333333333333",
            parent_tool_use_id: null,
            message: {
              content: [{
                type: "tool_use",
                id: "tool-native-1",
                name: "Bash",
                input: { command: "npm test" },
              }],
            },
          } as unknown as SDKMessage;
          yield {
            type: "user",
            session_id: "33333333-3333-4333-8333-333333333333",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: "tool-native-1",
                content: [{ type: "text", text: "passed" }],
              }],
            },
          } as unknown as SDKMessage;
          // Let the non-blocking context control response settle without
          // making terminal result handling wait for it.
          await new Promise<void>((resolve) => setImmediate(resolve));
          yield {
            type: "rate_limit_event",
            session_id: "33333333-3333-4333-8333-333333333333",
            rate_limit_info: {
              status: "allowed",
              rateLimitType: "five_hour",
              utilization: 30,
              resetsAt: 1_893_456_000,
            },
          } as unknown as SDKMessage;
          yield {
            type: "result",
            subtype: "success",
            session_id: "33333333-3333-4333-8333-333333333333",
            result: "Claude response",
            num_turns: 1,
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
    const activities: Array<{ activityId?: string; detail?: string; phase: string }> = [];

    const result = await manager.run({
      ...nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-rich",
        cwd: root,
        prompt: "Inspect this image",
        interactionMode: "build",
        access: "supervised",
        model: "sonnet",
        reasoningEffort: "high",
        imagePaths: [imagePath],
      }),
      skills: [{
        source: "claude-native",
        name: "security-review",
      }],
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
      onActivity: (event) => activities.push(event),
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
      skills: ["security-review"],
    });
    const content = capturedMessage?.message.content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } });
    expect(content[1]).toEqual({ type: "text", text: "Inspect this image" });
    expect(approvals).toEqual(["Run tests"]);
    expect(questions).toEqual(["Which scope?"]);
    expect(questionIds).toEqual(["tool-2:question:1"]);
    expect(plans).toEqual(["Inspect", "Implement"]);
    expect(reasoning).toEqual(["Checking constraints"]);
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "tool-native-1",
      phase: "started",
      detail: "Command:\nnpm test",
    }));
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "tool-native-1",
      phase: "completed",
      detail: "Output:\npassed",
    }));
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
      // oxlint-disable-next-line require-yield -- The empty inventory fixture must not emit SDK messages.
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

  it("discovers and force-reloads Claude skills without sending a prompt", async () => {
    let promptWasRead = false;
    let reloads = 0;
    const createQuery = ({ prompt }: {
      prompt: string | AsyncIterable<SDKUserMessage>;
    }): Query => {
      // oxlint-disable-next-line require-yield -- Control-only discovery emits no SDK messages.
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        promptWasRead = true;
        for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
          // A control-only query must not receive a user message.
        }
      })();
      return Object.assign(stream, {
        supportedCommands: async () => [{
          name: "review",
          description: "Review the repository.",
          argumentHint: "<scope>",
        }],
        reloadSkills: async () => {
          reloads += 1;
          return {
            skills: [{
              name: "review",
              description: "Review the repository.",
              argumentHint: "<scope>",
            }],
          };
        },
        close: () => undefined,
      }) as unknown as Query;
    };

    await expect(readClaudeAgentSdkSkills(
      "/fake/claude",
      {},
      "/workspace",
      false,
      1_000,
      createQuery,
    )).resolves.toEqual([expect.objectContaining({ name: "review" })]);
    await expect(readClaudeAgentSdkSkills(
      "/fake/claude",
      {},
      "/workspace",
      true,
      1_000,
      createQuery,
    )).resolves.toEqual([expect.objectContaining({ name: "review" })]);
    expect(reloads).toBe(1);
    expect(promptWasRead).toBe(false);
  });

  it("preserves local Claude interactions for Kimi without reading native Claude metadata", async () => {
    const root = portableFixtureRoot("Kimi through Claude SDK");
    roots.push(root);
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:sdk-local-mechanics",
      secretReference: "secret:kimi-sdk-local-mechanics",
      primaryModelId: "k3",
      contextWindowTokens: 1_048_576,
    });
    const backendProfile = modelBackendProfileForClaudeProfile(profile);
    const modelSelection = createKimiClaudeModelSelection({
      profile,
      reasoningEffort: "xhigh",
    });
    let capturedOptions: ClaudeOptions | undefined;
    let supportedModelsCalls = 0;
    let nativeQuotaCalls = 0;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        capturedOptions = options;
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          const canUseTool = options?.canUseTool as CanUseTool;
          await canUseTool("Bash", { command: "npm test" }, {
            signal: new AbortController().signal,
            title: "Run tests",
            description: "Run the focused suite",
            toolUseID: "kimi-tool",
            requestId: "kimi-permission",
          });
          await canUseTool("AskUserQuestion", {
            questions: [{
              header: "Scope",
              question: "Which scope?",
              options: [{ label: "Focused", description: "Only this package" }],
            }],
          }, {
            signal: new AbortController().signal,
            toolUseID: "kimi-question",
            requestId: "kimi-question-permission",
          });
          yield {
            type: "stream_event",
            session_id: "77777777-7777-4777-8777-777777777777",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Kimi response" },
            },
          } as unknown as SDKMessage;
          yield {
            type: "result",
            subtype: "success",
            session_id: "77777777-7777-4777-8777-777777777777",
            result: "Kimi response",
            num_turns: 1,
            usage: { input_tokens: 50, output_tokens: 10 },
            modelUsage: { k3: { contextWindow: 1_048_576 } },
          } as unknown as SDKMessage;
        })();
        return Object.assign(stream, {
          supportedModels: async () => {
            supportedModelsCalls += 1;
            return [];
          },
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            nativeQuotaCalls += 1;
            return { rate_limits_available: true, rate_limits: {} };
          },
          getContextUsage: async () => ({
            totalTokens: 60,
            maxTokens: 1_048_576,
            isAutoCompactEnabled: true,
          }) as never,
          interrupt: async () => undefined,
          close: () => undefined,
        }) as unknown as Query;
      },
    });
    const registrations = claudeBackendProfileRegistrations([profile]);
    const manager = new ProviderManager({
      commands: { claude: "/fake/claude" },
      ...registrations,
      resolveBackendLaunchOptions: createClaudeBackendLaunchResolver({
        profiles: [profile],
        resolveSecret: async () => "kimi-sdk-secret",
      }),
    }, new AgentHarnessRegistry([harness]));
    const approvals: string[] = [];
    const questions: string[] = [];
    const usages: Array<number | null> = [];
    const metadata: unknown[] = [];

    const result = await manager.run({
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfile,
      backendCompatibility: claudeHarnessBackendCompatibility(profile),
      modelSelection,
      continuationIdentity: continuationIdentityForSelection(
        modelSelection,
        backendProfile.endpointIdentity,
        true,
      ),
      conversationId: "kimi-sdk-local",
      runId: "kimi-sdk-local-run",
      turnId: "kimi-sdk-local-turn",
      cwd: root,
      prompt: "Use the local Claude harness",
      model: modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort ?? undefined,
      interactionMode: "build",
      access: "supervised",
    }, {
      onApproval: (event) => {
        approvals.push(event.request.title);
        manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "approve",
        );
      },
      onInput: (event) => {
        const question = event.request.questions[0]!;
        questions.push(question.question);
        manager.respondToInput(event.conversationId, event.request.requestId, {
          [question.id]: [question.options[0]!.id],
        });
      },
      onUsage: (event) => usages.push(event.usage.usedTokens),
      onMetadata: (event) => metadata.push(event),
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "Kimi response",
      sessionId: "77777777-7777-4777-8777-777777777777",
    });
    expect(capturedOptions).toMatchObject({
      model: "k3[1m]",
      effort: "xhigh",
      env: expect.objectContaining({
        ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
        ANTHROPIC_MODEL: "k3[1m]",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "k3[1m]",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "k3[1m]",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "k3[1m]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "k3[1m]",
        CLAUDE_CODE_SUBAGENT_MODEL: "k3[1m]",
        CLAUDE_CODE_EFFORT_LEVEL: "max",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1048576",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
      }),
    });
    expect(approvals).toEqual(["Run tests"]);
    expect(questions).toEqual(["Which scope?"]);
    expect(usages).toEqual([60]);
    expect(supportedModelsCalls).toBe(0);
    expect(nativeQuotaCalls).toBe(0);
    expect(metadata).toEqual([]);
    expect(manager.cachedMetadata("claude").models).toEqual([]);
    expect(manager.cachedMetadata("claude").rateLimits).toEqual([]);
  });

  it("keeps the run active until delegated work returns, then resumes the same SDK session", async () => {
    const root = portableFixtureRoot("Claude SDK delegated wait");
    roots.push(root);
    let createCalls = 0;
    let closeCalls = 0;
    let generatorCleanupCalls = 0;
    let resumedWith: string | undefined;
    let markSuspended!: () => void;
    const suspended = new Promise<void>((resolve) => { markSuspended = resolve; });
    let releaseDelegate!: () => void;
    const delegateFinished = new Promise<void>((resolve) => {
      releaseDelegate = resolve;
    });

    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        createCalls += 1;
        if (createCalls === 1) {
          const stream = (async function* (): AsyncGenerator<SDKMessage> {
            try {
              yield claudeBackgroundTasks(["agent-47"]);
              yield claudeSystem("task_started", {
                task_id: "agent-47",
                description: "Inspect delegated lifecycle",
              });
              yield claudeSuccessResult(
                "Delegated work is still running",
                "background_requested",
              );
              markSuspended();
              await delegateFinished;
              yield claudeBackgroundTasks([]);
              yield claudeSystem("task_notification", {
                task_id: "agent-47",
                status: "completed",
                output_file: "/tmp/agent-47",
                summary: "Delegated lifecycle inspected",
              });
              yield claudeSessionState("running");
              yield claudeSuccessResult(
                "Delegate result received",
                "completed",
              );
              yield claudeSessionState("idle");
            } finally {
              generatorCleanupCalls += 1;
            }
          })();
          return fixtureClaudeQuery(stream, {
            close: () => { closeCalls += 1; },
          });
        }

        resumedWith = options?.resume;
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          try {
            yield claudeSuccessResult("Follow-up complete", "completed");
            yield claudeSessionState("idle");
          } finally {
            generatorCleanupCalls += 1;
          }
        })();
        return fixtureClaudeQuery(stream, {
          close: () => { closeCalls += 1; },
        });
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const statuses: string[] = [];
    let firstSettled = false;
    const firstRun = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-delegated-wait",
      cwd: root,
      prompt: "Delegate lifecycle research",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: ({ status }) => statuses.push(status),
    }).then((value) => {
      firstSettled = true;
      return value;
    });

    await suspended;
    expect(firstSettled).toBe(false);
    expect(manager.activeConversationIds()).toContain("claude-delegated-wait");
    expect(statuses).toEqual(["starting", "running"]);

    releaseDelegate();
    const firstResult = await firstRun;
    expect(firstResult).toMatchObject({
      status: "completed",
      text: "Delegate result received",
    });
    expect(firstResult.text).not.toContain("still running");

    const followUp = await manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-delegated-follow-up",
      cwd: root,
      prompt: "Use the delegated result",
      interactionMode: "build",
      access: "supervised",
      sessionId: firstResult.sessionId,
    }));

    expect(followUp).toMatchObject({
      status: "completed",
      text: "Follow-up complete",
      sessionId: firstResult.sessionId,
    });
    expect(resumedWith).toBe(firstResult.sessionId);
    expect(closeCalls).toBe(2);
    expect(generatorCleanupCalls).toBe(2);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("queues an active parent follow-up on the same Query and stops an exact live task", async () => {
    const root = portableFixtureRoot("Claude SDK active follow-up");
    roots.push(root);
    const prompts: SDKUserMessage[] = [];
    const stoppedTaskIds: string[] = [];
    let releaseStop!: () => void;
    const stopRequested = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => {
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[
            Symbol.asyncIterator
          ]();
          prompts.push((await iterator.next()).value!);
          yield claudeSystem("task_started", {
            task_id: "task-live",
            tool_use_id: "tool-live",
            description: "Inspect the edge case",
            subagent_type: "researcher",
          });
          await stopRequested;
          prompts.push((await iterator.next()).value!);
          yield claudeSystem("task_notification", {
            task_id: "task-live",
            tool_use_id: "tool-live",
            status: "stopped",
            output_file: "/tmp/task-live",
            summary: "Stopped by the user",
          });
          yield claudeSuccessResult("Parent follow-up handled", "completed");
          yield claudeSessionState("idle");
        })();
        return fixtureClaudeQuery(stream, {
          stopTask: async (taskId) => {
            stoppedTaskIds.push(taskId);
            releaseStop();
          },
        });
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    let followUpAccepted: Promise<boolean> | null = null;
    let stopAccepted: Promise<boolean> | null = null;
    const traceStatuses: string[] = [];
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-active-follow-up",
      runId: "claude-active-run",
      turnId: "claude-active-turn",
      cwd: root,
      prompt: "Start delegated work",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || followUpAccepted) return;
        followUpAccepted = manager.steer(
          event.conversationId,
          "Check the second condition too.",
          { runId: event.runId, turnId: event.turnId! },
        );
      },
      onSubagent: (event) => {
        traceStatuses.push(event.status);
        if (event.status !== "spawned" || stopAccepted) return;
        stopAccepted = manager.stopSubagent(
          event.conversationId,
          event.providerTaskId!,
          { runId: event.runId, turnId: event.turnId! },
        );
      },
    });

    await expect(result).resolves.toMatchObject({
      status: "completed",
      text: "Parent follow-up handled",
    });
    await expect(followUpAccepted).resolves.toBe(true);
    await expect(stopAccepted).resolves.toBe(true);
    expect(stoppedTaskIds).toEqual(["task-live"]);
    expect(traceStatuses).toEqual(["spawned", "cancelled"]);
    const promptText = (message: SDKUserMessage): string =>
      ((message.message.content as unknown as Array<{ text?: string }>)[0]
        ?.text ?? "");
    expect(prompts.map(promptText)).toEqual([
      "Start delegated work",
      "Check the second condition too.",
    ]);
  });

  it("cancels and cleans up while the parent is suspended on a delegate", async () => {
    const root = portableFixtureRoot("Claude SDK delegated cancellation");
    roots.push(root);
    let interruptCalls = 0;
    let closeCalls = 0;
    let generatorCleanupCalls = 0;
    let markSuspended!: () => void;
    const suspended = new Promise<void>((resolve) => { markSuspended = resolve; });
    let releaseStream!: () => void;
    const interrupted = new Promise<void>((resolve) => { releaseStream = resolve; });

    const harness = createClaudeAgentSdkHarness({
      createQuery: () => {
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          try {
            yield claudeBackgroundTasks(["agent-cancel"]);
            yield claudeSuccessResult(
              "Delegated work is still running",
              "background_requested",
            );
            markSuspended();
            await interrupted;
          } finally {
            generatorCleanupCalls += 1;
          }
        })();
        return fixtureClaudeQuery(stream, {
          interrupt: async () => {
            interruptCalls += 1;
            releaseStream();
          },
          close: () => {
            closeCalls += 1;
            releaseStream();
          },
        });
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([harness]),
    );
    const run = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-delegate-cancel",
      cwd: root,
      prompt: "Wait for the delegate",
      interactionMode: "build",
      access: "supervised",
    }));

    await suspended;
    expect(manager.cancel("claude-delegate-cancel")).toBe(true);
    await expect(run).resolves.toMatchObject({ status: "cancelled" });
    expect(interruptCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(generatorCleanupCalls).toBe(1);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("fails closed when the SDK process exits with a live delegated roster", async () => {
    const root = portableFixtureRoot("Claude SDK abandoned delegate");
    roots.push(root);
    let closeCalls = 0;
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeBackgroundTasks(["agent-abandoned"]);
          yield claudeSuccessResult("Premature result", "completed");
        })(),
        { close: () => { closeCalls += 1; } },
      ),
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-abandoned-delegate",
      cwd: root,
      prompt: "Do not abandon the delegate",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Claude Agent SDK exited while delegated work was still running.",
      text: "",
    });
    expect(closeCalls).toBe(1);
    expect(manager.activeConversationIds()).toEqual([]);
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
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-cancel",
      cwd: root,
      prompt: "Wait for cancellation",
      interactionMode: "build",
      access: "supervised",
      sessionId: "resume-session",
    }), {
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
        // oxlint-disable-next-line require-yield -- Startup fails before the SDK can emit a message.
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

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-sdk-error",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({ status: "failed", error: "SDK transport unavailable" });
    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-bad-image",
      cwd: root,
      prompt: "Inspect",
      interactionMode: "build",
      access: "supervised",
      imagePaths: [unsupportedImage],
    }))).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("image type") });
    expect(queryCalls).toBe(1);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("attributes custom-backend authentication failures without exposing diagnostics", async () => {
    const root = portableFixtureRoot("Claude SDK custom auth failure");
    roots.push(root);
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:auth-failure",
      secretReference: "secret:kimi-auth-failure",
      primaryModelId: "k3",
    });
    const selection = createKimiClaudeModelSelection({ profile });
    const backendProfile = modelBackendProfileForClaudeProfile(profile);
    const compatibility = claudeHarnessBackendCompatibility(profile);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => {
        // oxlint-disable-next-line require-yield -- Authentication fails before the SDK can emit a message.
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          throw new Error(
            "401 Unauthorized from https://api.kimi.com/coding/ Authorization: Bearer raw-secret",
          );
        })();
        return Object.assign(stream, {
          supportedModels: async () => [],
          interrupt: async () => undefined,
          close: () => undefined,
        }) as unknown as Query;
      },
    });
    const registrations = claudeBackendProfileRegistrations([profile]);
    const manager = new ProviderManager({
      commands: { claude: process.execPath },
      ...registrations,
      resolveBackendLaunchOptions: createClaudeBackendLaunchResolver({
        profiles: [profile],
        resolveSecret: () => "owned-kimi-secret",
      }),
    }, new AgentHarnessRegistry([harness]));

    const result = await manager.run({
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfile,
      backendCompatibility: compatibility,
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        backendProfile.endpointIdentity,
        true,
      ),
      conversationId: "kimi-auth-failure",
      runId: "run-kimi-auth-failure",
      turnId: "turn-kimi-auth-failure",
      cwd: root,
      prompt: "Inspect",
      model: selection.modelId,
      interactionMode: "build",
      access: "supervised",
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "Authentication failed for Kimi. Check this model backend's credential and try again.",
    });
    expect(result.error).not.toMatch(/api\.kimi|authorization|raw-secret|owned-kimi-secret/iu);
    expect(manager.activeConversationIds()).toEqual([]);
  });
});
