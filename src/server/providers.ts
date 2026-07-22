import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  startCodexAppServerRun,
  type CodexApprovalDecision,
} from "./codex-app-server";
import { providerEnvironment } from "./environment";
import { terminateProcessTree } from "./process-lifecycle";
import {
  buildProviderInvocation,
  normalizeProviderLine,
  providerFailureMessage,
  validateProviderRunInput,
  type ProviderInvocation,
  type ProviderParserState,
} from "./provider/adapters";
import { providerAuthLoginArgs } from "./provider/auth";
import { PROVIDERS, PROVIDER_INFO } from "./provider/catalog";
import {
  PROVIDER_IDS,
  ProviderRuntimeError,
  type ProviderAuthLaunch,
  type ProviderDetection,
  type ProviderDetectionOptions,
  type ProviderId,
  type ProviderManagerOptions,
  type ProviderRunCallbacks,
  type ProviderRunInput,
  type ProviderRunResult,
  type ProviderRunStatus,
} from "./provider/contracts";
import { detectProvider, detectProviders } from "./provider/discovery";
import { createProviderEmitter, type ProviderEmitter } from "./provider/emitter";
import { CappedProviderBuffer, ProviderNdjsonDecoder } from "./provider/io";
import { readProviderMetadata, type ProviderMetadata } from "./provider/metadata";

export { PROVIDERS, PROVIDER_INFO, PROVIDER_IDS, ProviderRuntimeError, detectProvider, detectProviders };
export type * from "./provider/contracts";

interface ActiveRun {
  result: Promise<ProviderRunResult>;
  cancelRequested: boolean;
  settled: boolean;
  hardKillTimer?: NodeJS.Timeout;
  emitStatus: (status: ProviderRunStatus, message?: string) => void;
  cancel: (force: boolean) => void;
  respondToApproval?: (requestId: string, decision: CodexApprovalDecision) => boolean;
  respondToInput?: (requestId: string, answers: Record<string, string[]>) => boolean;
}

const MAX_NDJSON_LINE_CHARS = 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const DEFAULT_CANCEL_GRACE_MS = 2_000;

export class ProviderManager {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly commands: Partial<Record<ProviderId, string>>;
  private readonly resolvedCommands = new Map<ProviderId, string>();
  private readonly cancelGraceMs: number;
  private processEnvironment: NodeJS.ProcessEnv | undefined;

  constructor(options: ProviderManagerOptions = {}) {
    this.commands = { ...options.commands };
    this.cancelGraceMs = Math.max(100, Math.min(options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS, 30_000));
  }

  isRunning(conversationId: string): boolean {
    return this.activeRuns.has(conversationId);
  }

  activeConversationIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  async detect(providerId: ProviderId, options: Omit<ProviderDetectionOptions, "command"> = {}): Promise<ProviderDetection> {
    if (options.refreshEnvironment) await providerEnvironment(true);
    this.processEnvironment = (await providerEnvironment()).env;
    const configured = this.commands[providerId]?.trim() || PROVIDER_INFO[providerId].command;
    const detection = await detectProvider(providerId, { ...options, refreshEnvironment: false, command: configured });
    if (detection.executable) this.resolvedCommands.set(providerId, detection.executable);
    else this.resolvedCommands.delete(providerId);
    return detection;
  }

  async detectAll(options: Omit<ProviderDetectionOptions, "command"> = {}): Promise<ProviderDetection[]> {
    if (options.refreshEnvironment) await providerEnvironment(true);
    return await Promise.all(PROVIDER_IDS.map((id) => this.detect(id, { ...options, refreshEnvironment: false })));
  }

  async authLaunch(providerId: ProviderId): Promise<ProviderAuthLaunch> {
    let executable = this.resolvedCommands.get(providerId);
    if (!executable) executable = (await this.detect(providerId, { refreshEnvironment: true })).executable;
    if (!executable) throw new ProviderRuntimeError("invalid_input", `${PROVIDER_INFO[providerId].name} CLI is not installed.`);
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    return { executable, args: providerAuthLoginArgs(providerId), env: environment.env };
  }

  async metadata(providerId: ProviderId, cwd = process.cwd()): Promise<ProviderMetadata> {
    if (providerId !== "codex") return { models: [], rateLimits: [] };
    let executable = this.resolvedCommands.get(providerId);
    if (!executable) executable = (await this.detect(providerId)).executable;
    if (!executable) return { models: [], rateLimits: [] };
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    return await readProviderMetadata(providerId, executable, environment.env, cwd);
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks = {}): Promise<ProviderRunResult> {
    const conversationId = validateProviderRunInput(input);
    if (this.activeRuns.has(conversationId)) {
      throw new ProviderRuntimeError("already_running", "This conversation already has an active provider run.");
    }

    const providerId = input.providerId;
    const emitter = createProviderEmitter(providerId, conversationId, callbacks);
    if (providerId === "codex" && input.access !== "full") {
      return this.runInteractiveCodex(input, conversationId, emitter);
    }
    const parserState: ProviderParserState = {
      sessionId: input.sessionId,
      sawText: false,
      sawStreamingDelta: false,
      hadErrorEvent: false,
      failureText: undefined,
    };
    const stderr = new CappedProviderBuffer(MAX_STDERR_CHARS);
    const resultText = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
    let overflowReported = false;
    let spawnError: NodeJS.ErrnoException | undefined;

    const emitText = (text: string): void => {
      resultText.append(text);
      emitter.text(text);
    };
    const decoder = new ProviderNdjsonDecoder(
      MAX_NDJSON_LINE_CHARS,
      (line) => normalizeProviderLine(providerId, line, parserState, emitText, emitter.activity, emitter.session),
      () => {
        if (overflowReported) return;
        overflowReported = true;
        emitter.activity("system", "info", "Some oversized provider output was skipped");
      },
    );

    let invocation: ProviderInvocation;
    try {
      invocation = buildProviderInvocation(input, this.commandFor(providerId));
    } catch {
      emitter.status("failed", "The provider could not be started.");
      return Promise.resolve({
        providerId,
        conversationId,
        status: "failed",
        sessionId: parserState.sessionId,
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        error: "The provider could not be started.",
      });
    }

    emitter.status("starting");
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: input.cwd,
        env: this.processEnvironment ?? process.env,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
      const message = providerFailureMessage(providerId, spawnError, "");
      emitter.status("failed", message);
      return Promise.resolve({
        providerId,
        conversationId,
        status: "failed",
        sessionId: parserState.sessionId,
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        error: message,
      });
    }

    let resolveResult!: (result: ProviderRunResult) => void;
    const result = new Promise<ProviderRunResult>((resolve) => {
      resolveResult = resolve;
    });
    const active: ActiveRun = {
      result,
      cancelRequested: false,
      settled: false,
      emitStatus: emitter.status,
      cancel: (force) => terminateProcessTree(child, force),
    };
    this.activeRuns.set(conversationId, active);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (active.settled) return;
      active.settled = true;
      if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
      this.activeRuns.delete(conversationId);

      if (active.cancelRequested) {
        emitter.status("cancelled");
        resolveResult({
          providerId,
          conversationId,
          status: "cancelled",
          sessionId: parserState.sessionId,
          text: resultText.toString(),
          textTruncated: resultText.truncated,
          exitCode,
          signal,
        });
        return;
      }

      if (spawnError || exitCode !== 0 || parserState.hadErrorEvent) {
        const message = providerFailureMessage(providerId, spawnError, stderr.toString(), parserState.failureText);
        emitter.status("failed", message);
        resolveResult({
          providerId,
          conversationId,
          status: "failed",
          sessionId: parserState.sessionId,
          text: resultText.toString(),
          textTruncated: resultText.truncated,
          exitCode,
          signal,
          error: message,
        });
        return;
      }

      emitter.status("completed");
      resolveResult({
        providerId,
        conversationId,
        status: "completed",
        sessionId: parserState.sessionId,
        text: resultText.toString(),
        textTruncated: resultText.truncated,
        exitCode,
        signal,
      });
    };

    child.once("spawn", () => emitter.status("running"));
    child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    child.stdout.once("end", () => decoder.end());
    child.stdout.on("error", (error: NodeJS.ErrnoException) => {
      spawnError ??= error;
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
    child.stderr.on("error", () => {
      // Stderr is diagnostic-only and is never exposed directly.
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (invocation.stdin !== undefined) spawnError ??= error;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      finish(null, null);
    });
    child.once("close", finish);

    try {
      child.stdin.end(invocation.stdin);
    } catch (error) {
      spawnError = error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
      try {
        child.kill();
      } catch {
        // The close/error event will settle the public result.
      }
    }

    return result;
  }

  cancel(conversationId: string): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested) return false;
    active.cancelRequested = true;
    active.emitStatus("cancelling");
    try {
      active.cancel(false);
    } catch {
      // The close event may already be queued.
    }
    active.hardKillTimer = setTimeout(() => {
      if (active.settled) return;
      try {
        active.cancel(true);
      } catch {
        // The process may have exited between the check and kill.
      }
    }, this.cancelGraceMs);
    active.hardKillTimer.unref();
    return true;
  }

  async disposeAll(): Promise<void> {
    const active = [...this.activeRuns.entries()];
    for (const [conversationId] of active) this.cancel(conversationId);
    await Promise.allSettled(active.map(([, run]) => run.result));
  }

  respondToApproval(conversationId: string, requestId: string, decision: CodexApprovalDecision): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested || !active.respondToApproval) return false;
    return active.respondToApproval(requestId, decision);
  }

  respondToInput(conversationId: string, requestId: string, answers: Record<string, string[]>): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested || !active.respondToInput) return false;
    return active.respondToInput(requestId, answers);
  }

  private runInteractiveCodex(
    input: ProviderRunInput,
    conversationId: string,
    emitter: ProviderEmitter,
  ): Promise<ProviderRunResult> {
    emitter.status("starting");
    let runningEmitted = false;
    const emitRunning = (): void => {
      if (runningEmitted) return;
      runningEmitted = true;
      emitter.status("running");
    };

    let codexRun: ReturnType<typeof startCodexAppServerRun>;
    try {
      codexRun = startCodexAppServerRun({
        executable: this.commandFor("codex"),
        environment: this.processEnvironment ?? process.env,
        cwd: input.cwd,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.imagePaths ? { imagePaths: input.imagePaths } : {}),
        planMode: input.interactionMode === "plan",
        access: input.access === "auto-edit" ? "auto-edit" : "supervised",
        onText: emitter.text,
        onActivity: emitter.activity,
        onSession: emitter.session,
        onStatus: emitRunning,
        onApproval: emitter.approval,
        onApprovalResolved: emitter.approvalResolved,
        onInputRequest: emitter.input,
        onInputResolved: emitter.inputResolved,
        onPlan: emitter.plan,
        onReasoning: emitter.reasoning,
        onUsage: emitter.usage,
      });
    } catch (error) {
      const spawnError = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
      const message = providerFailureMessage("codex", spawnError, "");
      emitter.status("failed", message);
      return Promise.resolve({
        providerId: "codex",
        conversationId,
        status: "failed",
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        error: message,
      });
    }

    let active!: ActiveRun;
    const result = codexRun.result.then((runtimeResult): ProviderRunResult => {
      const { diagnostic: runtimeDiagnostic, ...publicRuntimeResult } = runtimeResult;
      active.settled = true;
      if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
      this.activeRuns.delete(conversationId);
      if (runtimeResult.status === "cancelled" || active.cancelRequested) {
        emitter.status("cancelled");
        return { providerId: "codex", conversationId, ...publicRuntimeResult, status: "cancelled" };
      }
      if (runtimeResult.status === "failed") {
        const message = providerFailureMessage("codex", undefined, runtimeDiagnostic ?? "");
        emitter.status("failed", message);
        return { providerId: "codex", conversationId, ...publicRuntimeResult, status: "failed", error: message };
      }
      emitter.status("completed");
      return { providerId: "codex", conversationId, ...publicRuntimeResult, status: "completed" };
    });

    active = {
      result,
      cancelRequested: false,
      settled: false,
      emitStatus: emitter.status,
      cancel: codexRun.cancel,
      respondToApproval: codexRun.respondToApproval,
      respondToInput: codexRun.respondToInput,
    };
    this.activeRuns.set(conversationId, active);
    return result;
  }

  private commandFor(providerId: ProviderId): string {
    const resolved = this.resolvedCommands.get(providerId);
    if (resolved) return resolved;
    const configured = this.commands[providerId]?.trim();
    if (configured && !configured.includes("\0")) return configured;
    return PROVIDER_INFO[providerId].command;
  }
}
