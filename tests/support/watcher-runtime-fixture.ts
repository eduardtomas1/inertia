import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { vi } from "vitest";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ChatAttachment,
  ClientCommand,
  ModelSelection,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { providerNativeModelSelection, type KnownHarnessId } from "../../src/shared/model-routing";
import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING, type WatcherLinkView } from "../../src/shared/watcher";
import { RuntimeStore } from "../../src/server/database";
import type { CheckoutFingerprint, CheckoutFingerprintOptions } from "../../src/server/git/checkout-fingerprint";
import {
  providerRunTerminal,
  type ProviderEvent,
  type ProviderRunCallbacks,
  type ProviderRunFailure,
  type ProviderRunInput,
  type ProviderRunResult,
  type ProviderSteerInput,
} from "../../src/server/provider/contracts";
import { AGENT_CONTEXT_TOOL_DEFINITION } from "../../src/server/runtime/agent-context-tool";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import type { TurnProviderRuntime, TurnTimerScheduler } from "../../src/server/runtime/turns/turn-controller-types";
import {
  createWatcherRuntime,
  createWatcherTurnPolicy,
  type WatcherRuntime,
} from "../../src/server/runtime/watcher/watcher-runtime";
import { resolveNativeModelRoute } from "../server/model-route-fixture";
import { turnControllerTestProviderInfo } from "./turn-controller-runtime";

type ProviderEventBody = ProviderEvent extends infer Event
  ? Event extends ProviderEvent ? Omit<Event, "providerId" | "conversationId" | "runId" | "turnId"> : never
  : never;

interface Run {
  input: ProviderRunInput;
  callbacks: ProviderRunCallbacks;
  resolve(result: ProviderRunResult): void;
}

/** A fake provider that runs one turn per conversation, several conversations at once. */
export class MultiTurnProvider implements TurnProviderRuntime {
  readonly runs = new Map<string, Run>();
  readonly inputs: ProviderRunInput[] = [];
  readonly approvals: Array<{ conversationId: string; requestId: string; decision: AgentApprovalDecision }> = [];
  readonly steerCalls: Array<{ conversationId: string; content: string }> = [];
  readonly cancelled: string[] = [];
  steerSupported = true;
  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string { return input.harnessId; }
  providerCapabilityAvailable(): boolean { return true; }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult> {
    this.inputs.push(input);
    return new Promise((resolve) => {
      this.runs.set(input.conversationId, { input, callbacks, resolve });
      callbacks.onStarted?.();
    });
  }

  input(conversationId: string): ProviderRunInput {
    const run = this.runs.get(conversationId);
    if (!run) throw new Error(`No provider run for ${conversationId}.`);
    return run.input;
  }

  emit(conversationId: string, body: ProviderEventBody): void {
    const run = this.runs.get(conversationId);
    if (!run) throw new Error(`No provider run for ${conversationId}.`);
    const { providerId, runId, turnId } = run.input;
    run.callbacks.onEvent?.({ providerId, conversationId, runId, turnId, ...body } as ProviderEvent);
  }

  finish(conversationId: string, status: ProviderRunResult["status"] = "completed", failure?: ProviderRunFailure): void {
    const run = this.runs.get(conversationId);
    if (!run) throw new Error(`No provider run for ${conversationId}.`);
    this.runs.delete(conversationId);
    run.resolve({
      ...providerRunTerminal(run.input, status, failure),
      text: "", textTruncated: false, exitCode: 0, signal: null, cleanupConfirmed: true,
      ...(failure ? { failure } : {}),
    });
  }

  cancel(conversationId: string): boolean {
    this.cancelled.push(conversationId);
    return true;
  }

  async stopOwned(conversationId: string): Promise<"settled"> {
    this.runs.delete(conversationId);
    return "settled";
  }

  isRunning(conversationId: string): boolean { return this.runs.has(conversationId); }

  ownsRun(conversationId: string, identity: { runId: string; turnId: string }): boolean {
    const run = this.runs.get(conversationId);
    return run?.input.runId === identity.runId && run.input.turnId === identity.turnId;
  }

  respondToApproval(conversationId: string, requestId: string, decision: AgentApprovalDecision): boolean {
    this.approvals.push({ conversationId, requestId, decision });
    return true;
  }

  respondToInput(): boolean { return true; }

  async steer(conversationId: string, input: ProviderSteerInput): Promise<boolean> {
    this.steerCalls.push({ conversationId, content: input.content });
    return this.steerSupported;
  }

  async disposeAll(): Promise<void> {
    this.runs.clear();
  }
}

/** Time-ordered fake timers driven by `advance`. */
export class ManualTimers implements TurnTimerScheduler {
  now = Date.parse("2030-01-01T00:00:00.000Z");
  private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.next;
    this.pending.set(id, { at: this.now + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.pending].filter(([, timer]) => timer.at <= target).sort(([a, left], [b, right]) => left.at - right.at || a - b)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].callback();
    }
    this.now = target;
  }
}

function providerInfo(id: ProviderInfo["id"], harnessId: KnownHarnessId): ProviderInfo {
  const base = turnControllerTestProviderInfo();
  return {
    ...base,
    id,
    label: id,
    capabilityContract: { ...base.capabilityContract!, harnessId },
  };
}

export const WATCHER_TEST_PROVIDERS: ProviderInfo[] = [
  providerInfo("codex", "codex-app-server"),
  providerInfo("claude", "claude-agent-sdk"),
  providerInfo("opencode", "opencode-sdk"),
  providerInfo("cursor", "cursor-acp"),
];

export function watcherTestSelection(providerId: "codex" | "claude" | "opencode" | "cursor" = "codex"): ModelSelection {
  return providerNativeModelSelection({ providerId, modelId: "gpt-test", reasoningEffort: "high" });
}

const directories: string[] = [];

export interface WatcherFixtureOptions {
  watchedSelection?: ModelSelection;
  captureFingerprint?: (path: string, options: CheckoutFingerprintOptions) => Promise<CheckoutFingerprint>;
  providerInfo?: () => ProviderInfo[];
  readiness?: (selection: ModelSelection) => Promise<{ ready: boolean; message: string | null } | null>;
  /** The platform whose path rules the checkout guard applies. */
  platform?: NodeJS.Platform;
}

export async function createWatcherFixture(options: WatcherFixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "inertia-watcher-runtime-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
  const project = store.createProject("Watcher project", workspace);
  const watched = store.createConversation(project.id, "Fix the parser", {
    modelSelection: options.watchedSelection ?? watcherTestSelection("codex"),
    interactionMode: "build",
    accessMode: "supervised",
  });
  const provider = new MultiTurnProvider();
  const turnTimers = new ManualTimers();
  const timers = new ManualTimers();
  const events: ServerEvent[] = [];
  const sent: ServerEvent[] = [];
  const checkpoints: string[] = [];
  const gitArtifacts: string[] = [];
  const pendingApprovals = new Map<string, AgentApprovalRequest>();
  const pendingInputs = new Map<string, AgentInputRequest>();
  const plans = new Map<string, AgentPlan>();
  let infos = options.providerInfo ?? (() => WATCHER_TEST_PROVIDERS);
  let watchers: WatcherRuntime | undefined;
  let queue: ReturnType<typeof createQueuedMessageRuntime> | undefined;
  let clockMs = Date.parse("2030-01-01T00:00:00.000Z");
  const contextCalls: string[] = [];
  const policy = createWatcherTurnPolicy(store, (source) => ({
    definitions: [AGENT_CONTEXT_TOOL_DEFINITION],
    invoke: async () => {
      contextCalls.push(source.turn.id);
      return { success: true, text: "{}" };
    },
  }));
  const controller = new TurnController(store, provider, pendingApprovals, pendingInputs, plans, {
    broadcast: (event) => {
      events.push(event);
      watchers?.observe(event);
    },
    broadcastSnapshot: () => undefined,
    providerInfo: () => infos(),
    harnessInstructionsForTurn: (input) => policy.harnessInstructionsFor(input)
      ?? [{ label: "inertia-orchestration", text: "Capability pack." }],
    hostToolsForTurn: (input) => policy.hostToolsForTurn(input) ?? {
      definitions: [AGENT_CONTEXT_TOOL_DEFINITION, { ...AGENT_CONTEXT_TOOL_DEFINITION, name: "inertia_spawn_agent" }],
      invoke: async () => ({ success: true, text: "{}" }),
    },
    createTurnCheckpoint: async (turn) => {
      checkpoints.push(turn.id);
      return { checkpointId: null, failure: null };
    },
    captureGitArtifacts: ({ turn }) => { gitArtifacts.push(turn.id); },
    onReadOnlyViolation: (turn, violation) => watchers?.onReadOnlyViolation(turn, violation),
    onTurnSettled: async (turn) => {
      queue?.onTurnSettled(turn);
      await watchers?.onTurnSettled(turn);
    },
  }, {
    scheduler: turnTimers,
    clock: () => new Date(clockMs++),
    id: randomUUID,
    turnTimeoutMs: 600_000,
  });
  const attachments = await ConversationAttachmentStore.open(directory);
  const abort = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const backendProfileController = {
    validateSelection: (selection: ModelSelection) => selection,
    isExternalSelection: () => false,
    readiness: options.readiness ?? (async () => null),
  };
  const interaction: TurnInteractionCommandDependencies = {
    store, turns: controller, conversationAttachments: attachments,
    backendProfileController: backendProfileController as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals, pendingInputs, dataDirectory: directory, enableProviders: true,
    attachmentResolver: {
      resolvePayloads: async (requested: ChatAttachment[]) => requested.map((attachment) => ({ attachment, bytes: Buffer.alloc(0) })),
      releaseAll: async () => undefined, relinquishAll: async () => undefined,
    } as unknown as TurnInteractionCommandDependencies["attachmentResolver"],
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: { resolveTurnSkills: async () => ({ inputs: [], routeKey: null }), assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: { isActive: () => false, acquireWhenAvailable: async () => true, release: () => undefined } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => infos(), broadcast: (event) => { events.push(event); watchers?.observe(event); },
    broadcastSnapshot: () => undefined, send: (_socket, event) => { sent.push(event); },
  };
  queue = createQueuedMessageRuntime(interaction, {
    signal: abort.signal,
    track: (operation) => {
      const task = operation();
      tasks.add(task);
      void task.finally(() => tasks.delete(task)).catch(() => undefined);
      return task;
    },
    onWatcherNoteUndelivered: (note, reason) => watchers?.delivery.noteUndelivered(note, reason),
  });
  const capture = vi.fn(options.captureFingerprint
    ?? (async (_path: string, _options: CheckoutFingerprintOptions) => ({ state: "unavailable", reason: "Not a repository." } as CheckoutFingerprint)));
  const buildRuntime = (): WatcherRuntime => createWatcherRuntime({
    store,
    turns: controller,
    providers: provider,
    backendProfileController: backendProfileController as never,
    providerInfo: () => infos(),
    policy,
    interaction,
    queuedMessages: queue,
    broadcast: (event) => { events.push(event); },
    broadcastSnapshot: () => undefined,
    send: (_socket, event) => { sent.push(event); },
    scheduler: timers,
    clock: () => timers.now,
    captureFingerprint: (path, captureOptions) => capture(path, captureOptions),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  watchers = buildRuntime();

  const flush = async (): Promise<void> => {
    for (let round = 0; round < 6; round += 1) {
      for (let step = 0; step < 10; step += 1) await Promise.resolve();
      await controller.drainSettlementTasks();
      while (tasks.size > 0) await Promise.allSettled(tasks);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const command = async (type: ClientCommand["type"], payload: unknown): Promise<ServerEvent> => {
    const requestId = randomUUID();
    await watchers!.handler(null as unknown as WebSocket, { type, requestId, payload } as ClientCommand);
    const reply = sent.find((event) => "requestId" in event && event.requestId === requestId);
    if (!reply) throw new Error(`No reply for ${type}.`);
    return reply;
  };

  const attach = async (overrides: Record<string, unknown> = {}): Promise<WatcherLinkView> => {
    const reply = await command("watcher.attach", {
      linkId: randomUUID(),
      watchedConversationId: watched.id,
      modelSelection: watcherTestSelection("codex"),
      preset: "reviewer",
      instructions: "",
      sharing: { ...DEFAULT_WATCHER_SHARING },
      budgets: { ...DEFAULT_WATCHER_BUDGETS },
      privateConnect: "inherit",
      initialReview: false,
      ...overrides,
    });
    if (reply.type !== "request.result" || reply.result.kind !== "watcher.link") throw new Error("Attach failed.");
    return reply.result.link;
  };

  /** Starts a turn in the watched chat and waits until its provider run is live. */
  const startWatchedTurn = async (content = "Fix the parser bug.") => {
    const queued = controller.queue({ conversationId: watched.id, content });
    controller.start(queued.turn.id);
    await vi.waitFor(() => { if (!provider.runs.has(watched.id)) throw new Error("not started"); });
    provider.emit(watched.id, { type: "status", status: "running" });
    return queued.turn;
  };

  /** Runs due watcher timers and waits for the resulting watcher turn to reach the provider. */
  const advance = async (ms: number): Promise<void> => {
    timers.advance(ms);
    await flush();
  };

  const finishTurn = async (
    conversationId: string,
    reply: string | null,
    status: ProviderRunResult["status"] = "completed",
    failure?: ProviderRunFailure,
  ): Promise<void> => {
    if (reply !== null) provider.emit(conversationId, { type: "text", text: reply });
    provider.finish(conversationId, status, failure);
    await flush();
  };

  const close = async (): Promise<void> => {
    watchers?.dispose();
    abort.abort();
    await flush();
    await controller.dispose();
    await attachments.close();
    store.close();
  };

  return {
    directory, workspace, store, project, watched, provider, controller, timers, turnTimers, events, sent,
    checkpoints, gitArtifacts, contextCalls, interaction, capture, policy,
    get watchers() { return watchers!; },
    get queue() { return queue!; },
    setProviderInfo(next: () => ProviderInfo[]) { infos = next; },
    restartRuntime() { watchers?.dispose(); watchers = buildRuntime(); return watchers; },
    flush, command, attach, startWatchedTurn, advance, finishTurn, close,
    linkView: (linkId: string) => store.watcherLinks.get(linkId)!,
    watcherEvents: () => events.filter((event) => event.type.startsWith("watcher.")),
  };
}

export type WatcherFixture = Awaited<ReturnType<typeof createWatcherFixture>>;

export async function cleanupWatcherFixtures(): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}
