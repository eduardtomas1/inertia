// @inertia-test-suite portable
// @inertia-harness claude-agent-sdk
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CanUseTool,
  Options as ClaudeOptions,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import {
  claudeHarnessBackendCompatibility,
  createKimiClaudeBackendProfile,
  createKimiClaudeModelSelection,
  modelBackendProfileForClaudeProfile,
} from "../../src/shared/claude-backend-profiles";
import {
  continuationIdentityForSelection,
} from "../../src/shared/model-routing";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  claudeQuestions,
  createClaudeAgentSdkHarness,
  readClaudeAgentSdkModels,
  readClaudeAgentSdkSkills,
} from "../../src/server/provider/claude-agent-sdk-harness";
import {
  CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
  CLAUDE_ISOLATED_SKILL_SETTINGS,
  discoverClaudeFilesystemSkills,
  stageClaudeSkillPlugin,
} from "../../src/server/provider/claude-skill-plugin";
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
import {
  fakeClaudeChild,
  waitForImmediateCondition,
  writeClaudeSkill,
} from "../helpers/claude-harness-fixture";

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
    expect(() => claudeQuestions("request-unsafe", "tool-unsafe", {
      questions: [{
        ...questions[0],
        question: "Approve\u202Etxt.exe",
      }],
    })).toThrow("invalid question 1");
    expect(() => claudeQuestions("request-normalized", "tool-normalized", {
      questions: [{
        ...questions[0],
        options: [
          { label: "Café", description: "First" },
          { label: "cafe\u0301", description: "Second" },
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
          for (let index = 0; index < 16_385; index += 1) {
            yield claudeSystem("status", { index });
          }
        })(),
      ),
    });
    const manager = ProviderManager.createForTests(
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
      error: "Claude exceeded the bounded event rate for this run.",
    });
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("uses structured prompts and bridges native approvals, questions, plans, thinking, and usage", async () => {
    const root = portableFixtureRoot("Claude SDK");
    roots.push(root);
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const skillPath = writeClaudeSkill(root, "security-review");
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "unsafe" }] }] },
      permissions: { allow: ["Bash(*)"] },
    }));
    let capturedMessage: SDKUserMessage | undefined;
    let capturedOptions: ClaudeOptions | undefined;
    let stagedPluginPath: string | undefined;
    const permissionResults: PermissionResult[] = [];

    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt, options }) => {
        capturedOptions = options;
        stagedPluginPath = options?.plugins?.[0]?.path;
        expect(stagedPluginPath).toBeTruthy();
        expect(readFileSync(
          join(stagedPluginPath!, "skills", "security-review", "SKILL.md"),
          "utf8",
        )).toContain("Review the repository carefully.");
        expect(existsSync(join(stagedPluginPath!, "hooks"))).toBe(false);
        expect(existsSync(join(stagedPluginPath!, ".mcp.json"))).toBe(false);
        expect(existsSync(join(stagedPluginPath!, "settings.json"))).toBe(false);
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          capturedMessage = (await iterator.next()).value;
          yield claudeSystem("init", {
            session_id: "33333333-3333-4333-8333-333333333333",
            plugins: [{
              name: CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
              path: stagedPluginPath,
            }],
            skills: options?.skills,
          });
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
    const manager = ProviderManager.createForTests(
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
        path: skillPath,
      }],
    }, {
      onApproval: (event) => {
        approvals.push(event.request.title);
        expect(manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "approve",
          { runId: event.runId, turnId: event.turnId },
        )).toBe(true);
      },
      onInput: (event) => {
        const question = event.request.questions[0]!;
        questions.push(question.question);
        questionIds.push(question.id);
        expect(question.id).not.toBe(question.question);
        expect(manager.respondToInput(event.conversationId, event.request.requestId, {
          [question.id]: [question.options[0]!.id],
        }, { runId: event.runId, turnId: event.turnId })).toBe(true);
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
    expect(CLAUDE_ISOLATED_SKILL_SETTINGS.syncClaudeAiSkills).toBe(false);
    expect(capturedOptions).toMatchObject({
      pathToClaudeCodeExecutable: "/fake/claude",
      settingSources: [],
      managedSettings: expect.objectContaining({
        disableAllHooks: true,
        disableSkillShellExecution: true,
        syncClaudeAiSkills: false,
        strictPluginOnlyCustomization: ["skills", "agents", "hooks", "mcp"],
      }),
      permissionMode: "default",
      includePartialMessages: true,
      model: "sonnet",
      effort: "high",
      plugins: [{
        type: "local",
        path: stagedPluginPath,
        skipMcpDiscovery: true,
      }],
      skills: [`${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:security-review`],
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
    expect(stagedPluginPath && existsSync(stagedPluginPath)).toBe(false);
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

  it.each(["supervised"] as const)(
    "rejects unsafe Claude approval fields before emitting them",
    async (access) => {
      const root = portableFixtureRoot(`Claude unsafe approval ${access}`);
      roots.push(root);
      const permissionResults: PermissionResult[] = [];
      let capturedOptions: ClaudeOptions | undefined;
      const harness = createClaudeAgentSdkHarness({
        createQuery: ({ options }) => {
          capturedOptions = options;
          const stream = (async function* (): AsyncGenerator<SDKMessage> {
            const canUseTool = options?.canUseTool as CanUseTool;
            const request = (
              toolName: string,
              input: Record<string, unknown>,
              fields: Record<string, unknown>,
            ) => canUseTool(toolName, input, {
              signal: new AbortController().signal,
              toolUseID: `tool-${permissionResults.length + 1}`,
              requestId: `permission-${permissionResults.length + 1}`,
              ...fields,
            });
            permissionResults.push((await request(
              "Write",
              { file_path: "safe.txt", content: "safe" },
              { title: "Write safe\u202Etxt" },
            ))!);
            permissionResults.push((await request(
              "Write",
              { file_path: "safe.txt", content: "safe" },
              { title: "Write file", description: "Update\u0000silently" },
            ))!);
            permissionResults.push((await request(
              "Bash",
              { command: "npm test\u202E" },
              { title: "Run tests", description: "Run the suite" },
            ))!);
            permissionResults.push((await request(
              "Write",
              { file_path: "safe.txt", content: "safe" },
              { title: "Write file", decisionReason: "Needed\u0000now" },
            ))!);
            permissionResults.push((await request(
              "Write",
              { file_path: "safe.txt", content: "safe" },
              { title: "Write file", blockedPath: "/tmp/safe\u2066path" },
            ))!);
            yield claudeSuccessResult("Done", "completed");
          })();
          return fixtureClaudeQuery(stream);
        },
      });
      const manager = ProviderManager.createForTests(
        { commands: { claude: process.execPath } },
        new AgentHarnessRegistry([harness]),
      );
      const approvals: string[] = [];

      await expect(manager.run(nativeProviderRunInput({
        providerId: "claude",
        conversationId: `claude-unsafe-approval-${access}`,
        cwd: root,
        prompt: "Try malformed permission requests",
        interactionMode: "build",
        access,
      }), {
        onApproval: (event) => {
          approvals.push(event.request.title);
          manager.respondToApproval(
            event.conversationId,
            event.request.requestId,
            "deny",
            { runId: event.runId, turnId: event.turnId },
          );
        },
      })).resolves.toMatchObject({ status: "completed" });

      expect(approvals).toEqual([]);
      expect(permissionResults).toHaveLength(5);
      expect(permissionResults.every((permission) =>
        permission.behavior === "deny"
        && permission.message === "Claude sent unsafe permission display text."
      )).toBe(true);
      expect(capturedOptions).toMatchObject({
        permissionMode: "default",
        allowDangerouslySkipPermissions: false,
      });
    },
  );

  it("maps the SDK's authoritative model inventory without sending a prompt", async () => {
    let promptWasRead = false;
    let discoveryOptions: ClaudeOptions | undefined;
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const terminateProcessTree = vi.fn(async () => true);
    const models = await readClaudeAgentSdkModels("/fake/claude", {}, "/workspace", 1_000, ({ prompt, options }) => {
      discoveryOptions = options;
      options?.spawnClaudeCodeProcess?.({
        command: "/sdk/final/claude",
        args: ["--metadata"],
        cwd: "/workspace",
        env: { SDK_METADATA: "1" },
        signal: new AbortController().signal,
      });
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
          supportsFastMode: true,
        }],
        interrupt: async () => undefined,
        close: () => undefined,
      }) as unknown as Query;
    }, { spawnProcess, terminateProcessTree });

    expect(promptWasRead).toBe(false);
    expect(discoveryOptions?.settingSources).toEqual([]);
    expect(discoveryOptions?.managedSettings)
      .toEqual(CLAUDE_ISOLATED_SKILL_SETTINGS);
    expect(discoveryOptions?.managedSettings?.syncClaudeAiSkills).toBe(false);
    expect(discoveryOptions?.mcpServers).toBeUndefined();
    expect(discoveryOptions?.strictMcpConfig).toBeUndefined();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/sdk/final/claude",
      ["--metadata"],
      expect.objectContaining({
        detached: process.platform !== "win32",
        shell: false,
      }),
    );
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(child, true);
    expect(models).toEqual([expect.objectContaining({
      id: "sonnet",
      label: "Sonnet",
      isDefault: true,
      inputModalities: ["text", "image"],
      defaultReasoningEffort: "high",
      reasoningOptions: [expect.objectContaining({ value: "low" }), expect.objectContaining({ value: "high" })],
      fastMode: expect.objectContaining({
        providerValue: "fast",
        label: "Fast",
        isDefault: false,
      }),
    })]);
  });

  it("surfaces unconfirmed Claude metadata process-tree cleanup", async () => {
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    await expect(readClaudeAgentSdkModels(
      "/fake/claude",
      {},
      "/workspace",
      1_000,
      ({ options }) => {
        options?.spawnClaudeCodeProcess?.({
          command: "/fake/claude",
          args: [],
          cwd: "/workspace",
          env: {},
          signal: new AbortController().signal,
        });
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield* [];
          })(),
          { supportedModels: async () => [] },
        );
      },
      { spawnProcess, terminateProcessTree: async () => false },
    )).rejects.toThrow("Claude metadata process tree could not be confirmed stopped");
  });

  it("bounds metadata discovery and awaits whole-tree cleanup when the SDK ignores abort", async () => {
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const terminateProcessTree = vi.fn(async () => true);

    await expect(readClaudeAgentSdkModels(
      "/fake/claude",
      {},
      "/workspace",
      25,
      ({ options }) => {
        options?.spawnClaudeCodeProcess?.({
          command: "/fake/claude",
          args: [],
          cwd: "/workspace",
          env: {},
          signal: new AbortController().signal,
        });
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield* [];
          })(),
          { supportedModels: () => new Promise(() => undefined) },
        );
      },
      { spawnProcess, terminateProcessTree },
    )).rejects.toThrow("Claude metadata discovery timed out");

    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(child, true);
  });

  it("discovers and force-reloads Claude skills without sending a prompt", async () => {
    const root = portableFixtureRoot("Claude isolated skill discovery");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    let promptWasRead = false;
    let reloads = 0;
    const discoveryOptions: ClaudeOptions[] = [];
    const pluginPaths: string[] = [];
    const createQuery = ({ prompt, options }: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      options?: ClaudeOptions;
    }): Query => {
      if (options) {
        discoveryOptions.push(options);
        pluginPaths.push(options.plugins?.[0]?.path ?? "");
      }
      // oxlint-disable-next-line require-yield -- Control-only discovery emits no SDK messages.
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        promptWasRead = true;
        for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
          // A control-only query must not receive a user message.
        }
      })();
      return Object.assign(stream, {
        supportedCommands: async () => [{
          name: `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:review`,
          description: "Review the repository.",
          argumentHint: "<scope>",
        }],
        reloadSkills: async () => {
          reloads += 1;
          return {
            skills: [{
              name: `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:review`,
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
      root,
      false,
      1_000,
      createQuery,
    )).resolves.toEqual([expect.objectContaining({
      name: "review",
      path: skillPath,
      scope: "repo",
    })]);
    await expect(readClaudeAgentSdkSkills(
      "/fake/claude",
      {},
      root,
      true,
      1_000,
      createQuery,
    )).resolves.toEqual([expect.objectContaining({ name: "review" })]);
    expect(reloads).toBe(1);
    expect(promptWasRead).toBe(false);
    expect(discoveryOptions).toHaveLength(2);
    expect(discoveryOptions.every(({ settingSources }) =>
      settingSources?.length === 0)).toBe(true);
    expect(discoveryOptions.every(({ managedSettings, plugins, skills }) =>
      managedSettings?.disableAllHooks === true
      && managedSettings.disableSkillShellExecution === true
      && managedSettings.syncClaudeAiSkills === false
      && plugins?.length === 1
      && plugins[0]?.skipMcpDiscovery === true
      && skills === "all")).toBe(true);
    expect(pluginPaths.every((path) => path.length > 0 && !existsSync(path)))
      .toBe(true);
  });

  it("times out a never-settling SDK query and reclaims staging after owned cleanup", async () => {
    const root = portableFixtureRoot("Claude skill discovery timeout");
    roots.push(root);
    writeClaudeSkill(root, "review");
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<boolean>((resolve) => {
      releaseCleanup = () => resolve(true);
    });
    const terminateProcessTree = vi.fn(async () => {
      markCleanupStarted();
      return await cleanupGate;
    });
    let stagedPath = "";
    let closeCalls = 0;
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = resolve;
    });
    const never = new Promise<never>(() => undefined);
    vi.useFakeTimers();
    try {
      const discovery = readClaudeAgentSdkSkills(
        "/fake/claude",
        {},
        root,
        false,
        25,
        ({ options }) => {
          markQueryStarted();
          stagedPath = options?.plugins?.[0]?.path ?? "";
          options?.spawnClaudeCodeProcess?.({
            command: "/fake/claude",
            args: [],
            cwd: root,
            env: {},
            signal: new AbortController().signal,
          });
          return fixtureClaudeQuery(
            (async function* (): AsyncGenerator<SDKMessage> {
              yield* [];
            })(),
            {
              supportedCommands: async () => await never,
              close: () => { closeCalls += 1; },
            },
          );
        },
        { spawnProcess, terminateProcessTree },
      );
      const rejected = expect(discovery).rejects.toThrow(
        "Claude skill discovery timed out",
      );
      let settled = false;
      void discovery.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await queryStarted;
      await vi.advanceTimersByTimeAsync(25);
      await cleanupStarted;

      expect(closeCalls).toBe(1);
      expect(terminateProcessTree).toHaveBeenCalledWith(child, true);
      expect(stagedPath).not.toBe("");
      expect(existsSync(stagedPath)).toBe(true);
      expect(settled).toBe(false);
      releaseCleanup();
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    await waitForImmediateCondition(() => !existsSync(stagedPath));
  });

  it("settles skill refresh while an individual filesystem operation is stalled", async () => {
    const root = portableFixtureRoot("Claude stalled skill refresh");
    roots.push(root);
    writeClaudeSkill(root, "review");
    let releaseFilesystem!: () => void;
    const filesystemGate = new Promise<void>((resolve) => {
      releaseFilesystem = resolve;
    });
    let markFilesystemStarted!: () => void;
    const filesystemStarted = new Promise<void>((resolve) => {
      markFilesystemStarted = resolve;
    });
    let intercepted = false;
    const createQuery = vi.fn();

    vi.useFakeTimers();
    try {
      const discovery = readClaudeAgentSdkSkills(
        "/fake/claude",
        {},
        root,
        false,
        25,
        createQuery,
        {},
        {
          beforeOperation: async () => {
            if (intercepted) return;
            intercepted = true;
            markFilesystemStarted();
            await filesystemGate;
          },
        },
      );
      const rejected = expect(discovery).rejects.toThrow(
        "Claude skill discovery timed out",
      );
      await filesystemStarted;
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(createQuery).not.toHaveBeenCalled();
      releaseFilesystem();
    } finally {
      vi.useRealTimers();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("refuses a lazy SDK spawn after timed-out skill cleanup", async () => {
    const root = portableFixtureRoot("Claude late skill-query spawn");
    roots.push(root);
    writeClaudeSkill(root, "review");
    const spawnProcess = vi.fn(() => fakeClaudeChild()) as unknown as typeof import("node:child_process").spawn;
    let lateSpawner: ClaudeOptions["spawnClaudeCodeProcess"];
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = resolve;
    });

    vi.useFakeTimers();
    try {
      const discovery = readClaudeAgentSdkSkills(
        "/fake/claude",
        {},
        root,
        false,
        25,
        ({ options }) => {
          lateSpawner = options?.spawnClaudeCodeProcess;
          markQueryStarted();
          return fixtureClaudeQuery(
            (async function* (): AsyncGenerator<SDKMessage> {
              yield* [];
            })(),
            { supportedCommands: () => new Promise(() => undefined) },
          );
        },
        { spawnProcess },
      );
      const rejected = expect(discovery).rejects.toThrow(
        "Claude skill discovery timed out",
      );
      await queryStarted;
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
    } finally {
      vi.useRealTimers();
    }

    expect(() => lateSpawner?.({
      command: "/fake/late-claude",
      args: [],
      cwd: root,
      env: {},
      signal: new AbortController().signal,
    })).toThrow("attempted to spawn after query shutdown");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("surfaces unconfirmed cleanup after a timed-out skill SDK control", async () => {
    const root = portableFixtureRoot("Claude timed-out unconfirmed skill cleanup");
    roots.push(root);
    writeClaudeSkill(root, "review");
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = resolve;
    });

    vi.useFakeTimers();
    try {
      const discovery = readClaudeAgentSdkSkills(
        "/fake/claude",
        {},
        root,
        false,
        25,
        ({ options }) => {
          options?.spawnClaudeCodeProcess?.({
            command: "/fake/claude",
            args: [],
            cwd: root,
            env: {},
            signal: new AbortController().signal,
          });
          markQueryStarted();
          return fixtureClaudeQuery(
            (async function* (): AsyncGenerator<SDKMessage> {
              yield* [];
            })(),
            { supportedCommands: () => new Promise(() => undefined) },
          );
        },
        { spawnProcess, terminateProcessTree: async () => false },
      );
      const rejected = expect(discovery).rejects.toThrow(
        "Claude skill discovery process tree could not be confirmed stopped",
      );
      await queryStarted;
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pre-query staging and removes a late mkdtemp result", async () => {
    const root = portableFixtureRoot("Claude cancelled skill staging");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    let releaseMkdtemp!: () => void;
    const mkdtempGate = new Promise<void>((resolve) => {
      releaseMkdtemp = resolve;
    });
    let markMkdtempFinished!: () => void;
    const mkdtempFinished = new Promise<void>((resolve) => {
      markMkdtempFinished = resolve;
    });
    let stagedPath = "";
    const createQuery = vi.fn();
    const harness = createClaudeAgentSdkHarness({
      createQuery,
      skillFilesystem: {
        afterOperation: async (operation, _path, result) => {
          if (operation !== "mkdtemp") return;
          stagedPath = typeof result === "string" ? result : "";
          markMkdtempFinished();
          await mkdtempGate;
        },
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const result = manager.run({
      ...nativeProviderRunInput({
        providerId: "claude",
        conversationId: "claude-cancel-staging",
        cwd: root,
        prompt: "Use the selected skill",
        interactionMode: "build",
        access: "supervised",
      }),
      skills: [{ source: "claude-native", name: "review", path: skillPath }],
    });

    await mkdtempFinished;
    expect(stagedPath).not.toBe("");
    expect(existsSync(stagedPath)).toBe(true);
    expect(manager.cancel("claude-cancel-staging")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(createQuery).not.toHaveBeenCalled();

    releaseMkdtemp();
    await waitForImmediateCondition(() => !existsSync(stagedPath));
  });

  it("discovers bounded project and user skills without reading settings", async () => {
    const root = portableFixtureRoot("Claude filesystem skill sources");
    roots.push(root);
    const home = join(root, "home");
    const project = join(root, "project", "nested");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(root, "project", ".git"), { recursive: true });
    const projectSkill = writeClaudeSkill(project, "project-review");
    const parentSkill = writeClaudeSkill(join(root, "project"), "parent-review");
    const userSkill = writeClaudeSkill(home, "user-review");
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "unsafe" }] }] },
    }));

    await expect(discoverClaudeFilesystemSkills(project, { HOME: home }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "project-review",
          path: projectSkill,
          scope: "repo",
        }),
        expect.objectContaining({
          name: "parent-review",
          path: parentSkill,
          scope: "repo",
        }),
        expect.objectContaining({
          name: "user-review",
          path: userSkill,
          scope: "user",
        }),
      ]));
  });

  it("bounds aggregate Claude skill discovery bytes before staging", async () => {
    const root = portableFixtureRoot("Claude aggregate skill bound");
    roots.push(root);
    for (let index = 0; index < 40; index += 1) {
      writeClaudeSkill(
        root,
        `review-${index}`,
        "x".repeat(220 * 1024),
      );
    }

    const skills = await discoverClaudeFilesystemSkills(root, {});
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.length).toBeLessThan(40);
  });

  it.skipIf(process.platform === "win32")(
    "fails closed for symlinked, oversized, tampered, and traversing skill capabilities",
    async () => {
      const root = portableFixtureRoot("Claude unsafe skill paths");
      roots.push(root);
      const validPath = writeClaudeSkill(root, "valid-review");
      const linkedDirectory = join(root, ".claude", "skills", "linked-review");
      mkdirSync(linkedDirectory, { recursive: true });
      symlinkSync(validPath, join(linkedDirectory, "SKILL.md"));
      const oversizedDirectory = join(root, ".claude", "skills", "oversized-review");
      mkdirSync(oversizedDirectory, { recursive: true });
      writeFileSync(
        join(oversizedDirectory, "SKILL.md"),
        `---\ndescription: Too large\n---\n${"x".repeat(256 * 1024)}`,
      );

      await expect(discoverClaudeFilesystemSkills(root, {})).resolves.toEqual([
        expect.objectContaining({ name: "valid-review", path: validPath }),
      ]);
      await expect(stageClaudeSkillPlugin([{
        source: "claude-native",
        name: "..",
        path: join(root, ".claude", "skills", "SKILL.md"),
      }], root, {})).rejects.toThrow("no longer available");

      rmSync(validPath);
      const replacement = join(root, "replacement-skill.md");
      writeFileSync(replacement, "---\ndescription: Replaced\n---\nUnsafe");
      symlinkSync(replacement, validPath);
      await expect(stageClaudeSkillPlugin([{
        source: "claude-native",
        name: "valid-review",
        path: validPath,
      }], root, {})).rejects.toThrow("no longer available");
    },
  );

  it("copies selected skill trees into a private bounded plugin and cleans it", async () => {
    const root = portableFixtureRoot("Claude staged selected skill");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    writeFileSync(join(dirname(skillPath), "guide.txt"), "bounded supporting data");
    const staged = await stageClaudeSkillPlugin([{
      source: "claude-native",
      name: "review",
      path: skillPath,
    }], root, {});

    expect(staged).not.toBeNull();
    expect(staged?.skillNames).toEqual([
      `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:review`,
    ]);
    expect(readFileSync(join(staged!.path, "skills", "review", "guide.txt"), "utf8"))
      .toBe("bounded supporting data");
    expect(existsSync(join(staged!.path, "hooks"))).toBe(false);
    expect(existsSync(join(staged!.path, ".mcp.json"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(staged!.path).mode & 0o777).toBe(0o700);
    }
    await staged!.cleanup();
    expect(existsSync(staged!.path)).toBe(false);
  });

  it("rejects an oversized selected-skill supporting file before spawning Claude", async () => {
    const root = portableFixtureRoot("Claude oversized skill resource");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "review");
    writeFileSync(
      join(dirname(skillPath), "oversized.bin"),
      Buffer.alloc(1024 * 1024 + 1),
    );

    await expect(stageClaudeSkillPlugin([{
      source: "claude-native",
      name: "review",
      path: skillPath,
    }], root, {})).rejects.toThrow("could not be revalidated");
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
    const manager = ProviderManager.createForTests({
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
          { runId: event.runId, turnId: event.turnId },
        );
      },
      onInput: (event) => {
        const question = event.request.questions[0]!;
        questions.push(question.question);
        manager.respondToInput(event.conversationId, event.request.requestId, {
          [question.id]: [question.options[0]!.id],
        }, { runId: event.runId, turnId: event.turnId });
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

  it("keeps a newer unknown task update drainable until its terminal notification", async () => {
    const root = portableFixtureRoot("Claude SDK future delegate state");
    roots.push(root);
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeBackgroundTasks(["agent-future"]);
          yield claudeSystem("task_started", {
            task_id: "agent-future",
            tool_use_id: "tool-agent-future",
            description: "Exercise a newer active state",
            subagent_type: "researcher",
          });
          yield claudeSystem("task_updated", {
            task_id: "agent-future",
            patch: { status: "future_active_state" },
          });
          yield claudeSuccessResult("Parent finished", "completed");
          yield claudeBackgroundTasks([]);
          yield claudeSystem("task_notification", {
            task_id: "agent-future",
            tool_use_id: "tool-agent-future",
            status: "completed",
            summary: "Future state completed authoritatively",
          });
          yield claudeSessionState("running");
          yield claudeSuccessResult("Parent finished", "completed");
        })(),
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const traces: Array<{
      providerStatus?: string | null;
      status: string;
      isLive: boolean;
      result: string | null;
    }> = [];

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-future-delegate-state",
      cwd: root,
      prompt: "Keep an unknown active state drainable",
      interactionMode: "build",
      access: "supervised",
    }), {
      onSubagent: ({ providerStatus, status, isLive, result }) => {
        traces.push({ providerStatus, status, isLive, result });
      },
    })).resolves.toMatchObject({
      status: "completed",
      text: "Parent finished",
    });
    expect(traces).toEqual([
      {
        providerStatus: null,
        status: "spawned",
        isLive: true,
        result: null,
      },
      {
        providerStatus: "future_active_state",
        status: "unknown",
        isLive: true,
        result: null,
      },
      {
        providerStatus: "completed",
        status: "completed",
        isLive: false,
        result: "Future state completed authoritatively",
      },
    ]);
  });

  it("does not let stale task edges revive a terminal delegate or its Stop control", async () => {
    const root = portableFixtureRoot("Claude SDK stale delegate update");
    roots.push(root);
    let stopTaskCalls = 0;
    let markStaleEdgesObserved!: () => void;
    const staleEdgesObserved = new Promise<void>((resolve) => {
      markStaleEdgesObserved = resolve;
    });
    let releaseParent!: () => void;
    const parentReleased = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const harness = createClaudeAgentSdkHarness({
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("task_started", {
            task_id: "agent-terminal",
            tool_use_id: "tool-agent-terminal",
            description: "Finish before a stale update",
            subagent_type: "researcher",
          });
          yield claudeSystem("task_notification", {
            task_id: "agent-terminal",
            tool_use_id: "tool-agent-terminal",
            status: "completed",
            summary: "Finished authoritatively",
          });
          yield claudeSystem("task_started", {
            task_id: "agent-terminal",
            tool_use_id: "tool-agent-terminal",
            description: "A stale repeated start",
            subagent_type: "researcher",
          });
          yield claudeSystem("task_updated", {
            task_id: "agent-terminal",
            patch: { status: "running" },
          });
          yield claudeSystem("task_updated", {
            task_id: "agent-terminal",
            patch: { status: "future_active_state" },
          });
          markStaleEdgesObserved();
          await parentReleased;
          yield claudeSuccessResult("Parent finished", "completed");
          yield claudeSessionState("idle");
        })(),
        {
          stopTask: async () => {
            stopTaskCalls += 1;
          },
        },
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const traces: Array<{ status: string; isLive: boolean }> = [];

    const run = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-terminal-stale-update",
      runId: "claude-terminal-stale-update-run",
      turnId: "claude-terminal-stale-update-turn",
      cwd: root,
      prompt: "Keep terminal state sticky",
      interactionMode: "build",
      access: "supervised",
    }), {
      onSubagent: (event) => {
        traces.push({ status: event.status, isLive: event.isLive });
      },
    });
    await staleEdgesObserved;
    const stopAccepted = manager.stopSubagent(
      "claude-terminal-stale-update",
      "agent-terminal",
      {
        runId: "claude-terminal-stale-update-run",
        turnId: "claude-terminal-stale-update-turn",
      },
    );
    releaseParent();
    await expect(run).resolves.toMatchObject({
      status: "completed",
      text: "Parent finished",
    });
    await expect(stopAccepted).resolves.toBe(false);
    expect(stopTaskCalls).toBe(0);
    expect(traces).toEqual([
      { status: "spawned", isLive: true },
      { status: "completed", isLive: false },
    ]);
  });

  it("bounds a missing terminal delegate notification after parent completion", async () => {
    const root = portableFixtureRoot("Claude SDK missing delegate notification");
    roots.push(root);
    let closeCalls = 0;
    let drainWaitStartedAt = 0;
    const harness = createClaudeAgentSdkHarness({
      terminalSubagentDrainTimeoutMs: 25,
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeBackgroundTasks(["agent-missing-notification"]);
          yield claudeSystem("task_started", {
            task_id: "agent-missing-notification",
            description: "Await a notification that never arrives",
            subagent_type: "researcher",
          });
          yield claudeSystem("task_updated", {
            task_id: "agent-missing-notification",
            patch: { status: "future_active_state" },
          });
          yield claudeSuccessResult("Parent still finished", "completed");
          yield claudeBackgroundTasks([]);
          drainWaitStartedAt = Date.now();
          await new Promise<void>(() => {});
        })(),
        {
          close: () => {
            closeCalls += 1;
          },
        },
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-missing-delegate-notification",
      cwd: root,
      prompt: "Do not let a missing notification wedge the parent",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Claude Agent SDK exited before the parent resumed after delegated work.",
      failure: {
        terminalEvent: "lifecycle/parent-not-resumed",
      },
    });
    expect(drainWaitStartedAt).toBeGreaterThan(0);
    expect(Date.now() - drainWaitStartedAt).toBeGreaterThanOrEqual(20);
    expect(closeCalls).toBe(1);
    expect(manager.activeConversationIds()).toEqual([]);
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
    const manager = ProviderManager.createForTests(
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
    const followUpImage = join(root, "follow-up.png");
    writeFileSync(followUpImage, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
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
          const initial = (await iterator.next()).value!;
          prompts.push(initial);
          yield claudeSystem("task_started", {
            task_id: "task-live",
            tool_use_id: "tool-live",
            description: "Inspect the edge case",
            subagent_type: "researcher",
          });
          await stopRequested;
          const followUp = (await iterator.next()).value!;
          prompts.push(followUp);
          yield claudeSystem("task_notification", {
            task_id: "task-live",
            tool_use_id: "tool-live",
            status: "stopped",
            output_file: "/tmp/task-live",
            summary: "Stopped by the user",
          });
          yield {
            ...claudeSuccessResult("Parent follow-up handled", "completed"),
            user_message_uuid: followUp.uuid,
          } as SDKMessage;
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
    const manager = ProviderManager.createForTests(
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
          {
            content: "Check the second condition too.",
            imagePaths: [followUpImage],
          },
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
      "",
    ]);
    expect(prompts[1]?.message.content).toEqual([
      expect.objectContaining({
        type: "image",
        source: expect.objectContaining({
          type: "base64",
          media_type: "image/png",
        }),
      }),
      { type: "text", text: "Check the second condition too." },
    ]);
  });

  it("discards accepted follow-ups and closes SDK survivors when Stop interrupts the parent", async () => {
    const root = portableFixtureRoot("Claude SDK stop with queued follow-up");
    roots.push(root);
    let promptIterator: AsyncIterator<SDKUserMessage> | undefined;
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let markInitialPromptRead!: () => void;
    const initialPromptRead = new Promise<void>((resolve) => {
      markInitialPromptRead = resolve;
    });
    let markInterrupted!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      markInterrupted = resolve;
    });
    let queuedAfterCancel: IteratorResult<SDKUserMessage> | undefined;
    let closeCalls = 0;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => {
        promptIterator = (prompt as AsyncIterable<SDKUserMessage>)[
          Symbol.asyncIterator
        ]();
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          await promptIterator!.next();
          markInitialPromptRead();
          yield claudeSessionState("running");
          await streamReleased;
        })();
        return fixtureClaudeQuery(stream, {
          interrupt: async () => {
            queuedAfterCancel = await promptIterator!.next();
            markInterrupted();
            // UUID-less follow-ups are omitted even when the SDK has already
            // pulled them into its own queue.
            return { still_queued: [] };
          },
          close: () => {
            closeCalls += 1;
            releaseStream();
          },
        });
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath }, cancelGraceMs: 30_000 },
      new AgentHarnessRegistry([harness]),
    );
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-stop-queued-follow-up",
      runId: "claude-stop-queued-run",
      turnId: "claude-stop-queued-turn",
      cwd: root,
      prompt: "Start the parent turn",
      interactionMode: "build",
      access: "full",
    }));

    await initialPromptRead;
    await expect(manager.steer(
      "claude-stop-queued-follow-up",
      { content: "Run another tool after this response.", imagePaths: [] },
      {
        runId: "claude-stop-queued-run",
        turnId: "claude-stop-queued-turn",
      },
    )).resolves.toBe(true);
    expect(manager.cancel("claude-stop-queued-follow-up")).toBe(true);
    await interrupted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closedBeforeForceFallback = closeCalls > 0;
    releaseStream();

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(queuedAfterCancel).toMatchObject({ done: true });
    expect(closedBeforeForceFallback).toBe(true);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("bounds an unacknowledged task stop without cancelling the parent", async () => {
    const root = portableFixtureRoot("Claude SDK bounded task stop");
    roots.push(root);
    let releaseParent!: () => void;
    const parentReleased = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const stopTaskIds: string[] = [];
    let closeCalls = 0;
    let markTaskSpawned!: () => void;
    const taskSpawned = new Promise<void>((resolve) => {
      markTaskSpawned = resolve;
    });
    const harness = createClaudeAgentSdkHarness({
      stopTaskTimeoutMs: 100,
      createQuery: () => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("task_started", {
            task_id: "task-hung-stop",
            tool_use_id: "tool-hung-stop",
            description: "Keep the parent alive",
            subagent_type: "researcher",
          });
          await parentReleased;
          yield claudeSystem("task_notification", {
            task_id: "task-hung-stop",
            tool_use_id: "tool-hung-stop",
            status: "completed",
            output_file: "/tmp/task-hung-stop",
            summary: "Parent continued after the stop timeout",
          });
          yield claudeSuccessResult("Parent completed", "completed");
          yield claudeSessionState("idle");
        })(),
        {
          stopTask: async (taskId) => {
            stopTaskIds.push(taskId);
            await new Promise<void>(() => {});
          },
          close: () => {
            closeCalls += 1;
          },
        },
      ),
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const traceStatuses: string[] = [];
    let stopAccepted: Promise<boolean> | null = null;
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-bounded-task-stop",
      runId: "claude-bounded-task-stop-run",
      turnId: "claude-bounded-task-stop-turn",
      cwd: root,
      prompt: "Start delegated work",
      interactionMode: "build",
      access: "supervised",
    }), {
      onSubagent: (event) => {
        traceStatuses.push(event.status);
        if (event.status !== "spawned" || stopAccepted) return;
        markTaskSpawned();
        stopAccepted = manager.stopSubagent(
          event.conversationId,
          event.providerTaskId!,
          { runId: event.runId, turnId: event.turnId! },
        );
        void stopAccepted.then(() => releaseParent());
      },
    });

    await taskSpawned;
    expect(manager.activeConversationIds())
      .toContain("claude-bounded-task-stop");
    expect(traceStatuses).toEqual(["spawned"]);
    await expect(stopAccepted).resolves.toBe(false);
    await expect(result).resolves.toMatchObject({
      status: "completed",
      text: "Parent completed",
    });
    expect(stopTaskIds).toEqual(["task-hung-stop"]);
    expect(traceStatuses).toEqual(["spawned", "completed"]);
    expect(closeCalls).toBe(1);
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
    const manager = ProviderManager.createForTests(
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
    const manager = ProviderManager.createForTests(
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

  it("spawns the SDK's final invocation without a shell and owns its process tree", async () => {
    const root = portableFixtureRoot("Claude SDK owned invocation");
    roots.push(root);
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    let queryClosed = false;
    let terminationStartedBeforeQueryClose = false;
    const terminateProcessTree = vi.fn(async () => {
      terminationStartedBeforeQueryClose = !queryClosed;
      return true;
    });
    const forwardedAbort = new AbortController();
    const sdkEnvironment = { SDK_FINAL_ENV: "preserved" };
    let spawnedProcess: SpawnedProcess | undefined;
    const harness = createClaudeAgentSdkHarness({
      spawnProcess,
      terminateProcessTree,
      createQuery: ({ options }) => {
        const spawnFromSdk = options?.spawnClaudeCodeProcess;
        if (!spawnFromSdk) throw new Error("missing Claude SDK process spawner");
        spawnedProcess = spawnFromSdk({
          command: "/sdk/final/claude",
          args: ["--sdk-final-flag", "value"],
          cwd: root,
          env: sdkEnvironment,
          signal: forwardedAbort.signal,
        } satisfies SpawnOptions);
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSuccessResult("Done", "completed");
          })(),
          { close: () => { queryClosed = true; } },
        );
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: "/configured/claude" } },
      new AgentHarnessRegistry([harness]),
    );

    await expect(manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-owned-invocation",
      cwd: root,
      prompt: "Complete",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({ status: "completed", text: "Done" });

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/sdk/final/claude",
      ["--sdk-final-flag", "value"],
      {
        cwd: root,
        env: sdkEnvironment,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    expect(spawnedProcess?.stdin).toBe(child.stdin);
    expect(spawnedProcess?.stdout).toBe(child.stdout);
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(child, true);
    expect(terminationStartedBeforeQueryClose).toBe(true);
  });

  it("shares one owned graceful-to-force shutdown across SDK kill, cancellation, and finalization", async () => {
    const root = portableFixtureRoot("Claude SDK shared termination");
    roots.push(root);
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const forwardedAbort = new AbortController();
    let finishGraceful!: (confirmed: boolean) => void;
    const gracefulTermination = new Promise<boolean>((resolve) => {
      finishGraceful = resolve;
    });
    let activeAttempts = 0;
    let maximumActiveAttempts = 0;
    const terminateProcessTree = vi.fn(async (_child, force: boolean) => {
      activeAttempts += 1;
      maximumActiveAttempts = Math.max(maximumActiveAttempts, activeAttempts);
      try {
        return force ? true : await gracefulTermination;
      } finally {
        activeAttempts -= 1;
      }
    });
    let spawnedProcess: SpawnedProcess | undefined;
    let markSpawned!: () => void;
    const processSpawned = new Promise<void>((resolve) => { markSpawned = resolve; });
    let releaseProvider!: () => void;
    const providerInterrupted = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const harness = createClaudeAgentSdkHarness({
      spawnProcess,
      terminateProcessTree,
      createQuery: ({ options }) => {
        const spawnFromSdk = options?.spawnClaudeCodeProcess;
        if (!spawnFromSdk) throw new Error("missing Claude SDK process spawner");
        spawnedProcess = spawnFromSdk({
          command: "/sdk/final/claude",
          args: [],
          cwd: root,
          env: {},
          signal: forwardedAbort.signal,
        });
        markSpawned();
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            await providerInterrupted;
            yield claudeSuccessResult("Late result", "completed");
          })(),
          {
            interrupt: async () => {
              releaseProvider();
              return undefined;
            },
          },
        );
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath }, cancelGraceMs: 30_000 },
      new AgentHarnessRegistry([harness]),
    );
    const statuses: string[] = [];
    const result = manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-shared-termination",
      cwd: root,
      prompt: "Wait",
      interactionMode: "build",
      access: "supervised",
    }), {
      onStatus: ({ status }) => statuses.push(status),
    });

    await processSpawned;
    expect(spawnedProcess?.kill("SIGTERM")).toBe(true);
    forwardedAbort.abort();
    expect(manager.cancel("claude-shared-termination")).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(terminateProcessTree).toHaveBeenCalledWith(child, false);
    expect(statuses).not.toContain("cancelled");

    finishGraceful(false);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(terminateProcessTree.mock.calls.map(([, force]) => force)).toEqual([
      false,
      true,
    ]);
    expect(maximumActiveAttempts).toBe(1);
    expect(statuses.at(-1)).toBe("cancelled");
  });

  it("maps unconfirmed Claude process-tree cleanup to one failed terminal result", async () => {
    const root = portableFixtureRoot("Claude SDK cleanup failure");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "cleanup-review");
    let stagedPluginPath = "";
    const child = fakeClaudeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const terminateProcessTree = vi.fn(async () => false);
    const harness = createClaudeAgentSdkHarness({
      spawnProcess,
      terminateProcessTree,
      createQuery: ({ options }) => {
        stagedPluginPath = options?.plugins?.[0]?.path ?? "";
        options?.spawnClaudeCodeProcess?.({
          command: "/sdk/final/claude",
          args: [],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        });
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("init", {
              plugins: [{
                name: CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
                path: stagedPluginPath,
              }],
              skills: options?.skills,
            });
            yield claudeSuccessResult("Done", "completed");
          })(),
        );
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    const statuses: string[] = [];

    await expect(manager.run({
      ...nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-cleanup-failure",
      cwd: root,
      prompt: "Complete",
      interactionMode: "build",
      access: "supervised",
      }),
      skills: [{
        source: "claude-native",
        name: "cleanup-review",
        path: skillPath,
      }],
    }, {
      onStatus: ({ status }) => statuses.push(status),
    })).resolves.toMatchObject({
      status: "failed",
      error: "Claude Code process tree could not be confirmed stopped.",
    });
    expect(statuses).not.toContain("completed");
    expect(statuses.filter((status) => status === "failed")).toEqual([
      "failed",
    ]);
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(child, true);
    expect(stagedPluginPath).not.toBe("");
    expect(existsSync(stagedPluginPath)).toBe(false);
  });

  it("resumes through the SDK contract and interrupts without leaving an active run", async () => {
    const root = portableFixtureRoot("Claude SDK cancellation");
    roots.push(root);
    const skillPath = writeClaudeSkill(root, "cancel-review");
    let capturedOptions: ClaudeOptions | undefined;
    let stagedPluginPath = "";
    let release!: () => void;
    const interrupted = new Promise<void>((resolve) => { release = resolve; });
    let interruptCalls = 0;
    let closeCalls = 0;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        capturedOptions = options;
        stagedPluginPath = options?.plugins?.[0]?.path ?? "";
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
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath }, cancelGraceMs: 500 },
      new AgentHarnessRegistry([harness]),
    );
    let running!: () => void;
    const started = new Promise<void>((resolve) => { running = resolve; });
    const statuses: string[] = [];
    const result = manager.run({
      ...nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-cancel",
      cwd: root,
      prompt: "Wait for cancellation",
      interactionMode: "build",
      access: "supervised",
      sessionId: "resume-session",
      }),
      skills: [{
        source: "claude-native",
        name: "cancel-review",
        path: skillPath,
      }],
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
    expect(stagedPluginPath).not.toBe("");
    expect(existsSync(stagedPluginPath)).toBe(false);
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
    const manager = ProviderManager.createForTests(
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
    const manager = ProviderManager.createForTests({
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
