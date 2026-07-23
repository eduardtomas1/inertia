import type { AgentApprovalDecision } from "./provider/interactions";
import { providerEnvironment } from "./environment";
import { validateProviderRunInput } from "./provider/adapters";
import {
  AgentHarnessRegistry,
  createDefaultAgentHarnessRegistry,
} from "./provider/agent-harness-registry";
import type {
  AgentHarnessCapabilities,
  AgentHarnessRun,
} from "./provider/agent-harness";
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
} from "./provider/contracts";
import { detectProvider, detectProviders } from "./provider/discovery";
import {
  createProviderEmitter,
  providerCallbacksFromHarness,
} from "./provider/emitter";
import {
  ProviderMetadataCache,
  type ProviderMetadata,
  type ProviderMetadataRequestOptions,
} from "./provider/metadata";
import { providerProcessInvocation } from "./provider/process";

export { PROVIDERS, PROVIDER_INFO, PROVIDER_IDS, ProviderRuntimeError, detectProvider, detectProviders };
export { AgentHarnessRegistry, createDefaultAgentHarnessRegistry };
export type * from "./provider/agent-harness";
export type * from "./provider/contracts";

interface ActiveRun {
  result: Promise<ProviderRunResult>;
  harnessRun: AgentHarnessRun;
  cancelRequested: boolean;
  settled: boolean;
  hardKillTimer?: NodeJS.Timeout;
}

const DEFAULT_CANCEL_GRACE_MS = 2_000;

export class ProviderManager {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly commands: Partial<Record<ProviderId, string>>;
  private readonly resolvedCommands = new Map<ProviderId, string>();
  private readonly cancelGraceMs: number;
  private readonly harnessRegistry: AgentHarnessRegistry;
  private readonly metadataCache: ProviderMetadataCache;
  private processEnvironment: NodeJS.ProcessEnv | undefined;

  constructor(
    options: ProviderManagerOptions & { metadataCache?: ProviderMetadataCache } = {},
    harnessRegistry: AgentHarnessRegistry = createDefaultAgentHarnessRegistry(),
  ) {
    this.commands = { ...options.commands };
    this.cancelGraceMs = Math.max(100, Math.min(options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS, 30_000));
    this.harnessRegistry = harnessRegistry;
    this.metadataCache = options.metadataCache ?? new ProviderMetadataCache();
  }

  isRunning(conversationId: string): boolean {
    return this.activeRuns.has(conversationId);
  }

  activeConversationIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  harnessCapabilities(providerId?: ProviderId): readonly AgentHarnessCapabilities[] {
    return this.harnessRegistry.capabilities(providerId);
  }

  async detect(providerId: ProviderId, options: Omit<ProviderDetectionOptions, "command"> = {}): Promise<ProviderDetection> {
    if (options.refreshEnvironment) await providerEnvironment(true);
    this.processEnvironment = (await providerEnvironment()).env;
    const configured = this.commands[providerId]?.trim() || PROVIDER_INFO[providerId].command;
    const detection = await detectProvider(providerId, { ...options, refreshEnvironment: false, command: configured });
    if (detection.executable) {
      this.resolvedCommands.set(providerId, detection.executable);
    } else {
      this.resolvedCommands.delete(providerId);
    }
    this.metadataCache.correlate(providerId, {
      executable: detection.executable ?? null,
      version: detection.version ?? null,
      authState: detection.authState,
    });
    return detection;
  }

  async validateCommand(
    providerId: ProviderId,
    command: string,
    options: Omit<ProviderDetectionOptions, "command"> = {},
  ): Promise<ProviderDetection> {
    return await detectProvider(providerId, { ...options, command });
  }

  setCommand(providerId: ProviderId, command?: string): void {
    const value = command?.trim();
    if (value) this.commands[providerId] = value;
    else delete this.commands[providerId];
    this.resolvedCommands.delete(providerId);
    this.metadataCache.invalidate(providerId);
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
    const invocation = providerProcessInvocation(executable, providerAuthLoginArgs(providerId), environment.env);
    return { executable: invocation.command, args: invocation.args, env: environment.env };
  }

  cachedMetadata(providerId: ProviderId): ProviderMetadata {
    return this.metadataCache.current(providerId);
  }

  async metadata(
    providerId: ProviderId,
    cwd = process.cwd(),
    options: ProviderMetadataRequestOptions = {},
  ): Promise<ProviderMetadata> {
    let executable = this.resolvedCommands.get(providerId);
    if (!executable) executable = (await this.detect(providerId)).executable;
    if (!executable) return this.metadataCache.current(providerId);
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    return await this.metadataCache.metadata(providerId, executable, environment.env, cwd, options);
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks = {}): Promise<ProviderRunResult> {
    const conversationId = validateProviderRunInput(input);
    if (this.activeRuns.has(conversationId)) {
      throw new ProviderRuntimeError("already_running", "This conversation already has an active provider run.");
    }

    const providerId = input.providerId;
    const executable = this.commandFor(providerId);
    if (!this.resolvedCommands.has(providerId)) this.resolvedCommands.set(providerId, executable);
    const managerCallbacks: ProviderRunCallbacks = {
      ...callbacks,
      onMetadata: (event) => {
        this.metadataCache.learn(
          event.providerId,
          this.resolvedCommands.get(event.providerId) ?? this.commandFor(event.providerId),
          event.metadata,
          event.source,
          { merge: !event.complete },
        );
        callbacks.onMetadata?.(event);
      },
    };
    const compatibilityEmitter = createProviderEmitter(providerId, conversationId, managerCallbacks);
    const harness = this.harnessRegistry.resolve(input);
    const harnessRun = harness.start({
      input,
      executable,
      environment: this.processEnvironment ?? process.env,
      callbacks: providerCallbacksFromHarness(compatibilityEmitter),
    });

    if (harnessRun.harnessId !== harness.id || harnessRun.providerId !== providerId) {
      try {
        harnessRun.cancel(true);
      } catch {
        // A malformed harness may already have stopped while returning its run.
      }
      throw new ProviderRuntimeError("invalid_input", `Agent harness '${harness.id}' returned a mismatched run.`);
    }

    let active!: ActiveRun;
    const settle = (): void => {
      if (active.settled) return;
      active.settled = true;
      if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
      this.activeRuns.delete(conversationId);
    };
    const result = harnessRun.result.then(
      (value) => {
        settle();
        return value;
      },
      (error: unknown) => {
        settle();
        throw error;
      },
    );
    active = {
      result,
      harnessRun,
      cancelRequested: false,
      settled: false,
    };
    this.activeRuns.set(conversationId, active);
    return result;
  }

  cancel(conversationId: string): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested) return false;
    active.cancelRequested = true;
    try {
      active.harnessRun.cancel(false);
    } catch {
      // The provider may already have queued its terminal event.
    }
    active.hardKillTimer = setTimeout(() => {
      if (active.settled) return;
      try {
        active.harnessRun.cancel(true);
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

  respondToApproval(conversationId: string, requestId: string, decision: AgentApprovalDecision): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested) return false;
    const extension = active.harnessRun.extension;
    if (!("respondToApproval" in extension)) return false;
    return extension.respondToApproval(requestId, decision);
  }

  respondToInput(conversationId: string, requestId: string, answers: Record<string, string[]>): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested) return false;
    const extension = active.harnessRun.extension;
    if (!("respondToInput" in extension)) return false;
    return extension.respondToInput(requestId, answers);
  }

  private commandFor(providerId: ProviderId): string {
    const resolved = this.resolvedCommands.get(providerId);
    if (resolved) return resolved;
    const configured = this.commands[providerId]?.trim();
    if (configured && !configured.includes("\0")) return configured;
    return PROVIDER_INFO[providerId].command;
  }
}
