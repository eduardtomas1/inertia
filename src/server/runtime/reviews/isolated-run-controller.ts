import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  Conversation,
  ContinuationIdentity,
  HarnessBackendCompatibility,
  KnownHarnessId,
  ModelBackendProfile,
  ModelSelection,
  ProviderId,
  TurnRequestContext,
  WorkspaceRun,
} from "../../../shared/contracts";
import { modelSelectionSchema } from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import type {
  OwnedProviderStopResult,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../providers";
import { assembleTurnRequest } from "../turns/request-context";

export const DEFAULT_ISOLATED_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_ISOLATED_RUN_OUTPUT_LIMIT = 512_000;
export const DEFAULT_ISOLATED_STOP_GRACE_MS = 2_500;
const MAX_ISOLATED_RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_ISOLATED_RUN_OUTPUT_LIMIT = 4 * 1024 * 1024;
const MAX_ISOLATED_EXECUTION_PROMPT = 4 * 1024 * 1024;

export type IsolatedRunKind = "selection-ask" | "diff-summary";
export type IsolatedRunToolPolicy = "none" | "read-only";
export type IsolatedRunInteractionPolicy = "fail-closed";
export type IsolatedRunStopReason =
  | "completed"
  | "cancelled"
  | "disconnected"
  | "runtime-shutdown"
  | "runtime-crash"
  | "timeout"
  | "unsupported-interaction"
  | "output-limit"
  | "provider-failed"
  | "provider-cancelled"
  | "result-rejected"
  | "setup-failed";

export interface IsolatedRunRequestContent {
  /** Optional user-facing content. The controller never persists or broadcasts it. */
  visibleContent: string | null;
  /** Fully assembled hidden provider payload. It is never placed in WorkspaceRun or snapshots. */
  executionPrompt: string;
}

export interface IsolatedRunSelection {
  modelSelection: ModelSelection;
}

export interface IsolatedRunResultContext {
  signal: AbortSignal;
  assertActive(): void;
}

export interface IsolatedRunRequest<Owner, Value> {
  kind: IsolatedRunKind;
  projectId: string;
  conversationId: string;
  owner: Owner;
  selection: IsolatedRunSelection;
  request: IsolatedRunRequestContent;
  label: string;
  detail: string;
  successDetail?: string;
  toolPolicy: IsolatedRunToolPolicy;
  interactionPolicy: IsolatedRunInteractionPolicy;
  timeoutMs?: number;
  outputLimitChars?: number;
  onStarted?(context: IsolatedRunResultContext): void;
  onResult(output: IsolatedProviderOutput, context: IsolatedRunResultContext): Value | Promise<Value>;
}

export interface IsolatedProviderOutput {
  text: string;
  providerResult: ProviderRunResult;
  taskId: string;
  runId: string;
  turnId: string;
  providerConversationId: string;
  harnessId: string;
  backendProfileId: string;
  modelSelection: ModelSelection;
  model: string | null;
}

export interface IsolatedRunCompletion<Value> extends IsolatedProviderOutput {
  value: Value;
}

export interface IsolatedRunProviderRuntime {
  resolveModelRoute(selection: ModelSelection): {
    providerId: ProviderId;
    harnessId: KnownHarnessId;
    backendProfile: ModelBackendProfile;
    compatibility: HarnessBackendCompatibility;
    continuationIdentity: ContinuationIdentity;
  };
  harnessIdFor(input: ProviderRunInput): string;
  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult>;
  isRunning(conversationId: string): boolean;
  stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string },
    graceMs?: number,
  ): Promise<OwnedProviderStopResult>;
}

export type IsolatedRunStore = Pick<RuntimeStore, "createWorkspaceRun" | "updateWorkspaceRun">;

export interface IsolatedRunFileSystem {
  create(prefix: string): Promise<string>;
  protect(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface IsolatedRunControllerOptions {
  id?: () => string;
  defaultTimeoutMs?: number;
  defaultOutputLimitChars?: number;
  stopGraceMs?: number;
  fileSystem?: IsolatedRunFileSystem;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

interface StopOutcome {
  reason: Exclude<IsolatedRunStopReason, "completed">;
  message: string;
}

interface ActiveIsolatedRun<Owner> {
  kind: IsolatedRunKind;
  taskId: string;
  runId: string;
  turnId: string;
  providerConversationId: string;
  conversationId: string;
  owner: Owner;
  workspaceRunId: string;
  providerStarted: boolean;
  providerPromise: Promise<ProviderRunResult> | null;
  providerStopPromise: Promise<OwnedProviderStopResult> | null;
  stop: Deferred<StopOutcome>;
  stopOutcome: StopOutcome | null;
  abort: AbortController;
  timeout: NodeJS.Timeout | null;
  temporaryDirectory: string | null;
  workspaceSettled: boolean;
  cleanupPromise: Promise<void> | null;
  finished: Deferred<void>;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), maximum));
}

function stopMessage(reason: Exclude<IsolatedRunStopReason, "completed">): string {
  switch (reason) {
    case "cancelled":
      return "The isolated agent task was stopped.";
    case "disconnected":
      return "The renderer that owned this isolated task disconnected.";
    case "runtime-shutdown":
      return "The local runtime shut down before the isolated task completed.";
    case "runtime-crash":
      return "The local runtime crashed before the isolated task completed.";
    case "timeout":
      return "The isolated agent task timed out and was stopped.";
    case "unsupported-interaction":
      return "The isolated agent requested an unsupported interaction (approval, question, or disallowed tool).";
    case "output-limit":
      return "The isolated agent exceeded the bounded output limit.";
    case "provider-failed":
      return "The isolated agent provider failed.";
    case "provider-cancelled":
      return "The isolated agent provider cancelled the task.";
    case "result-rejected":
      return "The isolated agent result could not be accepted.";
    case "setup-failed":
      return "The isolated agent task could not be started.";
  }
}

function workspaceStatus(reason: IsolatedRunStopReason): WorkspaceRun["status"] {
  if (reason === "completed") return "succeeded";
  if (
    reason === "cancelled"
    || reason === "disconnected"
    || reason === "runtime-shutdown"
    || reason === "runtime-crash"
    || reason === "provider-cancelled"
  ) return "cancelled";
  return "failed";
}

export class IsolatedRunError extends Error {
  constructor(
    readonly reason: Exclude<IsolatedRunStopReason, "completed">,
    message = stopMessage(reason),
  ) {
    super(message);
    this.name = "IsolatedRunError";
  }
}

/**
 * Lifecycle owner for auxiliary provider work. These runs intentionally never
 * enter the normal AgentTurn/session projection: their temporary identities,
 * hidden payload, provider conversation, process and directory exist only for
 * the duration of this controller-owned operation.
 */
export class IsolatedRunController<Owner extends object> {
  private readonly activeByConversation = new Map<string, ActiveIsolatedRun<Owner>>();
  private readonly activeByWorkspaceRun = new Map<string, ActiveIsolatedRun<Owner>>();
  private readonly id: () => string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultOutputLimitChars: number;
  private readonly stopGraceMs: number;
  private readonly fileSystem: IsolatedRunFileSystem;
  private closing = false;

  constructor(
    private readonly store: IsolatedRunStore,
    private readonly providers: IsolatedRunProviderRuntime,
    private readonly dataDirectory: string,
    private readonly broadcastSnapshot: () => void,
    options: IsolatedRunControllerOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.defaultTimeoutMs = boundedInteger(
      options.defaultTimeoutMs,
      DEFAULT_ISOLATED_RUN_TIMEOUT_MS,
      MAX_ISOLATED_RUN_TIMEOUT_MS,
    );
    this.defaultOutputLimitChars = boundedInteger(
      options.defaultOutputLimitChars,
      DEFAULT_ISOLATED_RUN_OUTPUT_LIMIT,
      MAX_ISOLATED_RUN_OUTPUT_LIMIT,
    );
    this.stopGraceMs = boundedInteger(
      options.stopGraceMs,
      DEFAULT_ISOLATED_STOP_GRACE_MS,
      30_000,
    );
    this.fileSystem = options.fileSystem ?? {
      create: (prefix) => mkdtemp(prefix),
      protect: async (path) => { await chmod(path, 0o500); },
      remove: async (path) => {
        await chmod(path, 0o700).catch(() => undefined);
        await rm(path, { recursive: true, force: true });
      },
    };
  }

  has(conversationId: string): boolean {
    return this.activeByConversation.has(conversationId);
  }

  ownsWorkspaceRun(workspaceRunId: string): boolean {
    return this.activeByWorkspaceRun.has(workspaceRunId);
  }

  async run<Value>(request: IsolatedRunRequest<Owner, Value>): Promise<IsolatedRunCompletion<Value>> {
    if (this.closing) throw new IsolatedRunError("runtime-shutdown");
    if (this.activeByConversation.has(request.conversationId)) {
      throw new IsolatedRunError("setup-failed", "An isolated agent task is already running for this thread.");
    }
    if (
      request.interactionPolicy !== "fail-closed"
      || (request.toolPolicy !== "none" && request.toolPolicy !== "read-only")
    ) {
      throw new IsolatedRunError("setup-failed", "The isolated task policy is not supported.");
    }
    if (
      !request.request.executionPrompt.trim()
      || request.request.executionPrompt.length > MAX_ISOLATED_EXECUTION_PROMPT
    ) {
      throw new IsolatedRunError("setup-failed", "The isolated task payload is empty or too large.");
    }

    const taskId = this.id();
    const runId = this.id();
    const turnId = this.id();
    const providerConversationId = `${request.conversationId}:isolated:${taskId}`;
    const active: ActiveIsolatedRun<Owner> = {
      kind: request.kind,
      taskId,
      runId,
      turnId,
      providerConversationId,
      conversationId: request.conversationId,
      owner: request.owner,
      workspaceRunId: taskId,
      providerStarted: false,
      providerPromise: null,
      providerStopPromise: null,
      stop: deferred<StopOutcome>(),
      stopOutcome: null,
      abort: new AbortController(),
      timeout: null,
      temporaryDirectory: null,
      workspaceSettled: false,
      cleanupPromise: null,
      finished: deferred<void>(),
    };
    this.activeByConversation.set(active.conversationId, active);
    this.activeByWorkspaceRun.set(active.workspaceRunId, active);
    const timeoutMs = boundedInteger(
      request.timeoutMs,
      this.defaultTimeoutMs,
      MAX_ISOLATED_RUN_TIMEOUT_MS,
    );

    let finalReason: IsolatedRunStopReason = "setup-failed";
    let finalDetail = stopMessage("setup-failed");
    let completion: IsolatedRunCompletion<Value> | null = null;
    try {
      this.store.createWorkspaceRun({
        id: active.workspaceRunId,
        kind: "agent",
        projectId: request.projectId,
        conversationId: request.conversationId,
        label: request.label,
        detail: request.detail,
        status: "running",
        port: null,
      });
      this.safeBroadcast();
      active.timeout = setTimeout(() => {
        this.requestStop(active, "timeout");
      }, timeoutMs);
      active.timeout.unref();
      if (request.onStarted) {
        request.onStarted({
          signal: active.abort.signal,
          assertActive: () => this.assertActive(active),
        });
        this.assertActive(active);
        this.safeBroadcast();
      }

      const directoryCreation = this.fileSystem.create(
        join(this.dataDirectory, `isolated-${request.kind}-`),
      );
      try {
        active.temporaryDirectory = await this.awaitStage(active, directoryCreation);
      } catch (error) {
        if (active.stopOutcome && !active.temporaryDirectory) {
          void directoryCreation.then(
            (directory) => this.fileSystem.remove(directory).catch(() => undefined),
            () => undefined,
          );
        }
        throw error;
      }
      await this.awaitStage(
        active,
        this.fileSystem.protect(active.temporaryDirectory),
      );
      this.assertActive(active);

      const modelSelection = modelSelectionSchema.parse(
        request.selection.modelSelection,
      );
      const route = this.providers.resolveModelRoute(modelSelection);
      const providerInput: ProviderRunInput = {
        providerId: route.providerId,
        harnessId: route.harnessId,
        backendProfile: route.backendProfile,
        backendCompatibility: route.compatibility,
        modelSelection,
        continuationIdentity: route.continuationIdentity,
        conversationId: active.providerConversationId,
        runId: active.runId,
        turnId: active.turnId,
        cwd: active.temporaryDirectory,
        prompt: request.request.executionPrompt,
        model: modelSelection.modelId === "provider-default"
          ? undefined
          : modelSelection.modelId,
        reasoningEffort: modelSelection.reasoningEffort || undefined,
        interactionMode: "plan",
        access: "supervised",
      };
      const harnessId = this.providers.harnessIdFor(providerInput);
      const outputLimit = boundedInteger(
        request.outputLimitChars,
        this.defaultOutputLimitChars,
        MAX_ISOLATED_RUN_OUTPUT_LIMIT,
      );
      let streamed = "";
      let outputExceeded = false;
      const callbacks: ProviderRunCallbacks = {
        onText: ({ text }) => {
          if (active.stopOutcome) return;
          if (streamed.length + text.length > outputLimit) {
            outputExceeded = true;
            this.requestStop(active, "output-limit");
            return;
          }
          streamed += text;
        },
        onActivity: (event) => {
          if (
            request.toolPolicy === "none"
            && (event.kind === "tool" || event.kind === "command")
          ) {
            this.requestStop(active, "unsupported-interaction");
          }
        },
        onApproval: () => {
          this.requestStop(active, "unsupported-interaction");
        },
        onInput: () => {
          this.requestStop(active, "unsupported-interaction");
        },
      };

      let providerPromise: Promise<ProviderRunResult>;
      try {
        providerPromise = this.providers.run(providerInput, callbacks);
        active.providerPromise = providerPromise;
        active.providerStarted = true;
      } catch {
        throw new IsolatedRunError("provider-failed");
      }
      if (active.stopOutcome) void this.stopProvider(active);

      const providerOutcome = providerPromise.then(
        (result) => ({ kind: "provider" as const, result }),
        () => ({ kind: "provider-error" as const }),
      );
      const first = await Promise.race([
        providerOutcome,
        active.stop.promise.then((outcome) => ({ kind: "stopped" as const, outcome })),
      ]);
      if (first.kind === "stopped") throw new IsolatedRunError(first.outcome.reason, first.outcome.message);
      if (first.kind === "provider-error") throw new IsolatedRunError("provider-failed");
      if (first.result.status === "cancelled") throw new IsolatedRunError("provider-cancelled");
      if (first.result.status !== "completed") throw new IsolatedRunError("provider-failed");
      if (first.result.textTruncated || outputExceeded) throw new IsolatedRunError("output-limit");

      const text = (first.result.text || streamed).slice(0, outputLimit);
      if ((first.result.text || streamed).length > outputLimit) {
        throw new IsolatedRunError("output-limit");
      }
      const output: IsolatedProviderOutput = {
        text,
        providerResult: first.result,
        taskId: active.taskId,
        runId: active.runId,
        turnId: active.turnId,
        providerConversationId: active.providerConversationId,
        harnessId,
        backendProfileId: route.backendProfile.id,
        modelSelection,
        model: modelSelection.modelId === "provider-default"
          ? null
          : modelSelection.modelId,
      };
      const resultValue = Promise.resolve().then(() => request.onResult(output, {
        signal: active.abort.signal,
        assertActive: () => this.assertActive(active),
      }));
      const accepted = await Promise.race([
        resultValue.then(
          (value) => ({ kind: "accepted" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        active.stop.promise.then((outcome) => ({ kind: "stopped" as const, outcome })),
      ]);
      if (accepted.kind === "stopped") {
        throw new IsolatedRunError(accepted.outcome.reason, accepted.outcome.message);
      }
      if (accepted.kind === "rejected") {
        const message = accepted.error instanceof Error
          ? accepted.error.message
          : stopMessage("result-rejected");
        throw new IsolatedRunError("result-rejected", message);
      }
      this.assertActive(active);
      finalReason = "completed";
      finalDetail = request.successDetail ?? request.detail;
      completion = { ...output, value: accepted.value };
    } catch (error) {
      const isolated = error instanceof IsolatedRunError
        ? error
        : new IsolatedRunError(active.stopOutcome?.reason ?? "setup-failed");
      finalReason = isolated.reason;
      finalDetail = isolated.message;
      if (
        !active.stopOutcome
        && (
          isolated.reason === "cancelled"
          || isolated.reason === "disconnected"
          || isolated.reason === "runtime-shutdown"
          || isolated.reason === "runtime-crash"
          || isolated.reason === "timeout"
          || isolated.reason === "unsupported-interaction"
          || isolated.reason === "output-limit"
        )
      ) {
        this.requestStop(active, isolated.reason);
      }
    } finally {
      await this.settleAndCleanup(active, finalReason, finalDetail);
    }

    if (completion) return completion;
    throw new IsolatedRunError(
      finalReason === "completed" ? "result-rejected" : finalReason,
      finalDetail,
    );
  }

  stopConversation(conversationId: string, kind?: IsolatedRunKind): boolean {
    const active = this.activeByConversation.get(conversationId);
    return active && (!kind || active.kind === kind)
      ? this.requestStop(active, "cancelled")
      : false;
  }

  stopWorkspaceRun(workspaceRunId: string): boolean {
    const active = this.activeByWorkspaceRun.get(workspaceRunId);
    return active ? this.requestStop(active, "cancelled") : false;
  }

  stopOwned(owner: Owner): number {
    let stopped = 0;
    for (const active of [...this.activeByConversation.values()]) {
      if (active.owner !== owner) continue;
      if (this.requestStop(active, "disconnected")) stopped += 1;
    }
    return stopped;
  }

  async dispose(cause: "runtime-shutdown" | "runtime-crash" = "runtime-shutdown"): Promise<void> {
    if (this.closing) {
      await Promise.allSettled(
        [...this.activeByConversation.values()].map(({ finished }) => finished.promise),
      );
      return;
    }
    this.closing = true;
    const active = [...this.activeByConversation.values()];
    for (const task of active) this.requestStop(task, cause);
    await Promise.allSettled(active.map(({ finished }) => finished.promise));
  }

  private requestStop(
    active: ActiveIsolatedRun<Owner>,
    reason: Exclude<IsolatedRunStopReason, "completed" | "provider-failed" | "provider-cancelled" | "result-rejected" | "setup-failed">,
  ): boolean {
    if (active.stopOutcome || !this.activeByConversation.has(active.conversationId)) return false;
    const outcome = { reason, message: stopMessage(reason) };
    active.stopOutcome = outcome;
    active.abort.abort(outcome);
    active.stop.resolve(outcome);
    void this.stopProvider(active);
    return true;
  }

  private assertActive(active: ActiveIsolatedRun<Owner>): void {
    if (active.stopOutcome) {
      throw new IsolatedRunError(active.stopOutcome.reason, active.stopOutcome.message);
    }
    if (this.activeByConversation.get(active.conversationId) !== active) {
      throw new IsolatedRunError("cancelled");
    }
  }

  private stopProvider(active: ActiveIsolatedRun<Owner>): Promise<OwnedProviderStopResult> {
    if (!active.providerStarted) return Promise.resolve("missing");
    active.providerStopPromise ??= this.providers.stopOwned(
      active.providerConversationId,
      { runId: active.runId, turnId: active.turnId },
      this.stopGraceMs,
    );
    return active.providerStopPromise;
  }

  private async awaitStage<Value>(
    active: ActiveIsolatedRun<Owner>,
    stage: Promise<Value>,
  ): Promise<Value> {
    const outcome = await Promise.race([
      stage.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      active.stop.promise.then((stop) => ({ kind: "stopped" as const, stop })),
    ]);
    if (outcome.kind === "value") return outcome.value;
    if (outcome.kind === "stopped") {
      throw new IsolatedRunError(outcome.stop.reason, outcome.stop.message);
    }
    throw outcome.error;
  }

  private settleAndCleanup(
    active: ActiveIsolatedRun<Owner>,
    reason: IsolatedRunStopReason,
    detail: string,
  ): Promise<void> {
    active.cleanupPromise ??= (async () => {
      if (active.timeout) clearTimeout(active.timeout);
      if (reason !== "completed" && active.providerStarted) {
        await this.stopProvider(active).catch(() => "force-detached");
      }
      if (!active.workspaceSettled) {
        active.workspaceSettled = true;
        try {
          this.store.updateWorkspaceRun(active.workspaceRunId, {
            status: workspaceStatus(reason),
            detail: detail.slice(0, 1_000),
          });
          this.safeBroadcast();
        } catch {
          // Lifecycle cleanup and provider termination must not be skipped when
          // the persisted Activity projection is temporarily unavailable.
        }
      }
      if (active.temporaryDirectory) {
        await this.fileSystem.remove(active.temporaryDirectory).catch(() => undefined);
      }
      if (this.activeByConversation.get(active.conversationId) === active) {
        this.activeByConversation.delete(active.conversationId);
      }
      if (this.activeByWorkspaceRun.get(active.workspaceRunId) === active) {
        this.activeByWorkspaceRun.delete(active.workspaceRunId);
      }
      active.finished.resolve();
    })();
    return active.cleanupPromise;
  }

  private safeBroadcast(): void {
    try {
      this.broadcastSnapshot();
    } catch {
      // Snapshot projection is recoverable from the durable WorkspaceRun row.
    }
  }
}

export function isolatedRunSelection(
  conversation: Pick<Conversation, "modelSelection">,
  modelOverride?: string | null,
): IsolatedRunSelection {
  const modelId = modelOverride || conversation.modelSelection.modelId;
  return {
    modelSelection: modelSelectionSchema.parse({
      ...conversation.modelSelection,
      modelId,
      alias: modelOverride ? modelOverride : conversation.modelSelection.alias,
      providerOptions: { ...conversation.modelSelection.providerOptions },
      capabilities: conversation.modelSelection.capabilities.map((capability) => ({
        ...capability,
      })),
    }),
  };
}

export function assembleReadOnlyReviewRequest(
  cwd: string,
  visibleContent: string,
  context: TurnRequestContext,
) {
  return assembleTurnRequest({
    cwd,
    visibleContent,
    context,
    internalInstructions: [{
      label: "read-only-diff-review",
      text: "Answer the user's question about the selected diff. Do not modify files, run mutating commands, request write access, or present this control text as part of the user's question.",
    }],
  });
}
