import type { AgentApprovalDecision } from "./provider/interactions";
import { officiallyAllowsModelSwitchWithinSession } from "../shared/continuation-policy";
import {
  CURSOR_ACP_TERMINAL_RESUME_VERIFIED_VERSION,
  cursorVersionHasVerifiedAcpTerminalResume,
} from "../shared/provider-terminal-resume";
import {
  backendProbeMatchesProfile,
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeResult,
} from "../shared/backend-probe";
import {
  continuationIdentityForSelection,
  legacyProviderIdForHarness,
  modelSelectionSchema,
  modelBackendProfileSchema,
  knownHarnessIdSchema,
  nativeBackendProfile,
  resolveHarnessBackendCompatibility,
  type ContinuationIdentity,
  type HarnessBackendCompatibility,
  type KnownHarnessId,
  type ModelBackendProfile,
  type ModelSelection,
} from "../shared/model-routing";
import {
  providerChildEnvironment,
  providerEnvironment,
} from "./environment";
import { validateProviderRunInput } from "./provider/adapters";
import {
  AgentHarnessRegistry,
  createDefaultAgentHarnessRegistry,
} from "./provider/agent-harness-registry";
import type {
  AgentHarnessCapabilities,
  AgentHarnessId,
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
  type ProviderBackendLaunchOptions,
  type ProviderId,
  type ProviderGoalMutation,
  type ProviderGoalSnapshot,
  type ProviderCompactionResult,
  type ProviderManagerOptions,
  type ProviderRunCallbacks,
  type ProviderRunInput,
  type ProviderRunResult,
  type ProviderSteerInput,
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
import { readClaudeAgentSdkSkills } from "./provider/claude-agent-sdk-harness";
import { providerProcessInvocation, providerPtyArguments } from "./provider/process";
import { isProcessTreeTerminationUnconfirmed } from "./process-lifecycle";
import {
  providerTerminalResumeLaunch,
  type ProviderTerminalResumeLaunch,
} from "./provider/terminal-resume";
import { PROVIDER_COMPACTION_OPERATION_TIMEOUT_MS } from "../shared/runtime-command-timeouts";

export { PROVIDERS, PROVIDER_INFO, PROVIDER_IDS, ProviderRuntimeError, detectProvider, detectProviders };
export { AgentHarnessRegistry, createDefaultAgentHarnessRegistry };
export type * from "./provider/agent-harness";
export type * from "./provider/contracts";

interface ActiveRun {
  result: Promise<ProviderRunResult>;
  lifecycleSettlement: Promise<void>;
  resolveLifecycleSettlement: () => void;
  harnessRun: AgentHarnessRun | null;
  harnessStartInvoked: boolean;
  launchAbort: AbortController;
  markPendingCancellation: () => void;
  runId: string;
  turnId: string | null;
  processCleanupConfirmed: boolean;
  cancelRequested: boolean;
  settled: boolean;
  detach: () => void;
  quarantine: () => void;
  hardKillTimer?: NodeJS.Timeout;
}

const DEFAULT_CANCEL_GRACE_MS = 2_000;
const MAX_OWNED_STOP_GRACE_MS = 30_000;
const FORCE_DETACH_GRACE_MS = 250;

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof (value as { then?: unknown }).then === "function";
}

export type OwnedProviderStopResult =
  | "missing"
  | "identity-mismatch"
  | "settled"
  | "force-detached";

export interface ResolvedModelRoute {
  providerId: ProviderId;
  harnessId: KnownHarnessId;
  backendProfile: ModelBackendProfile;
  compatibility: HarnessBackendCompatibility;
  continuationIdentity: ContinuationIdentity;
}

export interface CodexControlContext {
  executable: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
}

export class ProviderManager {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly commands: Partial<Record<ProviderId, string>>;
  private readonly resolvedCommands = new Map<ProviderId, string>();
  private readonly cancelGraceMs: number;
  private readonly harnessRegistry: AgentHarnessRegistry;
  private readonly metadataCache: ProviderMetadataCache;
  private readonly lifetimeSignal: AbortSignal;
  private readonly ownedLifetimeAbort?: AbortController;
  private readonly auxiliaryOperations = new Set<Promise<unknown>>();
  private readonly backendProfiles = new Map<string, ModelBackendProfile>();
  private readonly backendCompatibilities = new Map<string, HarnessBackendCompatibility>();
  private readonly backendProbeResults = new Map<string, BackendCompatibilityProbeResult>();
  private readonly protectedBackendProfileIds = new Set<string>();
  private readonly resolveBackendLaunchOptions:
    | ProviderManagerOptions["resolveBackendLaunchOptions"];
  private processEnvironment: NodeJS.ProcessEnv | undefined;
  private auxiliaryCleanupUnconfirmed = false;

  constructor(
    options: ProviderManagerOptions & { metadataCache?: ProviderMetadataCache } = {},
    harnessRegistry: AgentHarnessRegistry = createDefaultAgentHarnessRegistry(),
  ) {
    this.commands = { ...options.commands };
    this.cancelGraceMs = Math.max(100, Math.min(options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS, 30_000));
    this.harnessRegistry = harnessRegistry;
    this.metadataCache = options.metadataCache ?? new ProviderMetadataCache();
    this.ownedLifetimeAbort = options.lifetimeSignal
      ? undefined
      : new AbortController();
    this.lifetimeSignal = options.lifetimeSignal
      ?? this.ownedLifetimeAbort!.signal;
    this.resolveBackendLaunchOptions = options.resolveBackendLaunchOptions;
    for (const providerId of PROVIDER_IDS) {
      const profile = nativeBackendProfile(providerId);
      this.backendProfiles.set(profile.id, profile);
      this.protectedBackendProfileIds.add(profile.id);
    }
    for (const profile of options.backendProfiles ?? []) {
      const parsed = modelBackendProfileSchema.parse(profile);
      this.backendProfiles.set(parsed.id, parsed);
      if (parsed.source === "built-in") this.protectedBackendProfileIds.add(parsed.id);
    }
    for (const compatibility of options.backendCompatibilities ?? []) {
      this.backendCompatibilities.set(
        `${compatibility.harnessId}\0${compatibility.backendProfileId}`,
        compatibility,
      );
    }
    for (const result of options.backendProbeResults ?? []) {
      this.recordBackendProbeResult(result);
    }
  }

  isRunning(conversationId: string): boolean {
    return this.activeRuns.has(conversationId);
  }

  ownsRun(
    conversationId: string,
    identity: { runId: string; turnId: string | null },
  ): boolean {
    const active = this.activeRuns.get(conversationId);
    return Boolean(
      active
      && !active.settled
      && active.runId === identity.runId
      && active.turnId === identity.turnId,
    );
  }

  activeConversationIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  harnessCapabilities(providerId?: ProviderId): readonly AgentHarnessCapabilities[] {
    return this.harnessRegistry.capabilities(providerId);
  }

  harnessIdFor(input: ProviderRunInput): AgentHarnessId {
    validateProviderRunInput(input);
    return this.harnessRegistry.resolve(input).id;
  }

  recordBackendProbeResult(resultInput: BackendCompatibilityProbeResult): void {
    const result = backendCompatibilityProbeResultSchema.parse(resultInput);
    const profile = this.backendProfiles.get(result.profileId);
    if (!profile || !backendProbeMatchesProfile(result, profile, result.modelId)) return;
    const key = `${result.profileId}\0${result.modelId}`;
    const current = this.backendProbeResults.get(key);
    if (
      current
      && Date.parse(current.checkedAt) >= Date.parse(result.checkedAt)
    ) return;
    this.backendProbeResults.set(key, result);
  }

  upsertBackendProfile(profileInput: ModelBackendProfile): void {
    const profile = modelBackendProfileSchema.parse(profileInput);
    const current = this.backendProfiles.get(profile.id);
    if (current?.source === "built-in" && profile.source !== "built-in") {
      throw new ProviderRuntimeError(
        "invalid_input",
        `Built-in backend '${current.displayName}' cannot be replaced by a custom profile.`,
      );
    }
    if (
      current
      && (
        current.configurationRevision !== profile.configurationRevision
        || current.endpointIdentity !== profile.endpointIdentity
        || current.protocol !== profile.protocol
      )
    ) {
      this.removeBackendProbeResults(profile.id);
    }
    this.backendProfiles.set(profile.id, profile);
    if (profile.source === "built-in") this.protectedBackendProfileIds.add(profile.id);
  }

  removeBackendProfile(profileId: string): void {
    const current = this.backendProfiles.get(profileId);
    if (!current) return;
    if (this.protectedBackendProfileIds.has(profileId) || current.source === "built-in") {
      throw new ProviderRuntimeError(
        "invalid_input",
        `Built-in backend '${current.displayName}' cannot be removed.`,
      );
    }
    this.backendProfiles.delete(profileId);
    this.removeBackendProbeResults(profileId);
    for (const key of this.backendCompatibilities.keys()) {
      if (key.endsWith(`\0${profileId}`)) this.backendCompatibilities.delete(key);
    }
  }

  removeBackendProbeResults(profileId: string): void {
    for (const key of this.backendProbeResults.keys()) {
      if (key.startsWith(`${profileId}\0`)) this.backendProbeResults.delete(key);
    }
  }

  resolveModelRoute(selectionInput: ModelSelection): ResolvedModelRoute {
    const selection = modelSelectionSchema.parse(selectionInput);
    const harnessId = knownHarnessIdSchema.safeParse(selection.harnessId);
    const providerId = legacyProviderIdForHarness(selection.harnessId);
    if (!harnessId.success || !providerId) {
      throw new ProviderRuntimeError("invalid_input", `Unknown agent harness '${selection.harnessId}'.`);
    }
    const backendProfile = this.backendProfiles.get(selection.backendProfileId);
    if (!backendProfile || !backendProfile.enabled) {
      throw new ProviderRuntimeError(
        "invalid_input",
        `Model backend '${selection.backendProfileDisplayName}' is unavailable.`,
      );
    }
    if (backendProfile.configurationRevision !== selection.backendConfigurationRevision) {
      throw new ProviderRuntimeError(
        "invalid_input",
        `Model backend '${backendProfile.displayName}' changed. Start a new chat before continuing.`,
      );
    }
    const explicit = this.backendCompatibilities.get(
      `${selection.harnessId}\0${selection.backendProfileId}`,
    );
    const probe = this.backendProbeResults.get(
      `${selection.backendProfileId}\0${selection.modelId}`,
    );
    // Custom profiles are always adjudicated from exact probe evidence. An
    // optimistic registration must never bypass a stale or failed probe.
    const compatibility = backendProfile.source === "custom"
      ? resolveHarnessBackendCompatibility(harnessId.data, backendProfile, {
          modelId: selection.modelId,
          probe,
        })
      : explicit ?? resolveHarnessBackendCompatibility(
          harnessId.data,
          backendProfile,
          { modelId: selection.modelId, probe },
        );
    return {
      providerId,
      harnessId: harnessId.data,
      backendProfile,
      compatibility,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        backendProfile.endpointIdentity,
        !officiallyAllowsModelSwitchWithinSession(compatibility),
      ),
    };
  }

  private trackAuxiliary<T>(operation: () => Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation().finally(() => {
      this.auxiliaryOperations.delete(tracked);
    });
    this.auxiliaryOperations.add(tracked);
    return tracked;
  }

  detect(
    providerId: ProviderId,
    options: Omit<ProviderDetectionOptions, "command"> = {},
  ): Promise<ProviderDetection> {
    return this.trackAuxiliary(async () =>
      await this.detectProviderInfo(providerId, options));
  }

  private async detectProviderInfo(
    providerId: ProviderId,
    options: Omit<ProviderDetectionOptions, "command">,
  ): Promise<ProviderDetection> {
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    if (options.refreshEnvironment) await providerEnvironment(true);
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    const environment = await providerEnvironment();
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    this.processEnvironment = environment.env;
    const configured = this.commands[providerId]?.trim() || PROVIDER_INFO[providerId].command;
    let detection: ProviderDetection;
    try {
      detection = await detectProvider(providerId, {
        ...options,
        refreshEnvironment: false,
        command: configured,
        signal: this.lifetimeSignal,
      });
    } catch (error) {
      this.auxiliaryCleanupUnconfirmed ||=
        isProcessTreeTerminationUnconfirmed(error);
      throw error;
    }
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    this.auxiliaryCleanupUnconfirmed ||= !detection.cleanupConfirmed;
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

  validateCommand(
    providerId: ProviderId,
    command: string,
    options: Omit<ProviderDetectionOptions, "command"> = {},
  ): Promise<ProviderDetection> {
    return this.trackAuxiliary(async () =>
      await this.validateProviderCommand(providerId, command, options));
  }

  private async validateProviderCommand(
    providerId: ProviderId,
    command: string,
    options: Omit<ProviderDetectionOptions, "command">,
  ): Promise<ProviderDetection> {
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    let detection: ProviderDetection;
    try {
      detection = await detectProvider(providerId, {
        ...options,
        command,
        signal: this.lifetimeSignal,
      });
    } catch (error) {
      this.auxiliaryCleanupUnconfirmed ||=
        isProcessTreeTerminationUnconfirmed(error);
      throw error;
    }
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    this.auxiliaryCleanupUnconfirmed ||= !detection.cleanupConfirmed;
    return detection;
  }

  setCommand(providerId: ProviderId, command?: string): void {
    const value = command?.trim();
    if (value) this.commands[providerId] = value;
    else delete this.commands[providerId];
    this.resolvedCommands.delete(providerId);
    this.metadataCache.invalidate(providerId);
  }

  detectAll(
    options: Omit<ProviderDetectionOptions, "command"> = {},
  ): Promise<ProviderDetection[]> {
    return this.trackAuxiliary(async () => await this.detectAllProviders(options));
  }

  private async detectAllProviders(
    options: Omit<ProviderDetectionOptions, "command">,
  ): Promise<ProviderDetection[]> {
    if (options.refreshEnvironment) await providerEnvironment(true);
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    const settled = await Promise.allSettled(PROVIDER_IDS.map((id) =>
      this.detect(id, { ...options, refreshEnvironment: false })));
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
    return settled.map((result) => (result as PromiseFulfilledResult<ProviderDetection>).value);
  }

  async authLaunch(providerId: ProviderId): Promise<ProviderAuthLaunch> {
    let executable = this.resolvedCommands.get(providerId);
    if (!executable) executable = (await this.detect(providerId, { refreshEnvironment: true })).executable;
    if (!executable) throw new ProviderRuntimeError("invalid_input", `${PROVIDER_INFO[providerId].name} CLI is not installed.`);
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    const childEnvironment = providerChildEnvironment(
      providerId,
      environment.env,
    );
    const invocation = providerProcessInvocation(
      executable,
      providerAuthLoginArgs(providerId),
      childEnvironment,
    );
    return {
      executable: invocation.command,
      args: providerPtyArguments(invocation),
      env: childEnvironment,
    };
  }

  async terminalResumeLaunch(
    providerId: ProviderId,
    sessionId: string,
    cwd: string,
  ): Promise<ProviderTerminalResumeLaunch> {
    const detection = await this.detect(providerId, {
      cwd,
      refreshEnvironment: true,
    });
    if (!detection.executable) {
      throw new ProviderRuntimeError(
        "invalid_input",
        `${PROVIDER_INFO[providerId].name} CLI is not installed.`,
      );
    }
    if (
      providerId === "cursor"
      && !cursorVersionHasVerifiedAcpTerminalResume(detection.version)
    ) {
      throw new ProviderRuntimeError(
        "invalid_input",
        `This Cursor build is not verified to share ACP and terminal resume IDs. Verified build: ${CURSOR_ACP_TERMINAL_RESUME_VERIFIED_VERSION}.`,
      );
    }
    if (!detection.canRun) {
      throw new ProviderRuntimeError(
        "invalid_input",
        detection.statusMessage
          ? `${PROVIDER_INFO[providerId].name} cannot resume this session: ${detection.statusMessage}.`
          : `${PROVIDER_INFO[providerId].name} is not ready to resume this session.`,
      );
    }
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    const childEnvironment = providerChildEnvironment(
      providerId,
      environment.env,
    );
    try {
      return providerTerminalResumeLaunch(
        detection.executable,
        providerId,
        sessionId,
        childEnvironment,
      );
    } catch (error) {
      throw new ProviderRuntimeError(
        "invalid_input",
        error instanceof Error
          ? error.message
          : "The saved provider session ID is invalid or stale.",
      );
    }
  }

  cachedMetadata(providerId: ProviderId): ProviderMetadata {
    return this.metadataCache.current(providerId);
  }

  cachedMetadataForSelection(selectionInput: ModelSelection): ProviderMetadata {
    const route = this.resolveModelRoute(selectionInput);
    const executable = this.resolvedCommands.get(route.providerId)
      ?? this.commandFor(route.providerId);
    const scope = this.metadataCache.scopeForSelection(
      selectionInput,
      route.backendProfile,
      executable,
    );
    return this.metadataCache.currentScoped(scope);
  }

  metadata(
    providerId: ProviderId,
    cwd = process.cwd(),
    options: ProviderMetadataRequestOptions = {},
  ): Promise<ProviderMetadata> {
    return this.trackAuxiliary(async () =>
      await this.readMetadata(providerId, cwd, options));
  }

  private async readMetadata(
    providerId: ProviderId,
    cwd: string,
    options: ProviderMetadataRequestOptions,
  ): Promise<ProviderMetadata> {
    const signal = this.lifetimeSignal;
    if (signal.aborted) return this.metadataCache.current(providerId);
    let executable = this.resolvedCommands.get(providerId);
    if (!executable) executable = (await this.detect(providerId, {
      signal,
    })).executable;
    if (!executable) return this.metadataCache.current(providerId);
    const environment = await providerEnvironment();
    if (signal.aborted) return this.metadataCache.current(providerId);
    this.processEnvironment = environment.env;
    return await this.metadataCache.metadata(
      providerId,
      executable,
      providerChildEnvironment(providerId, environment.env),
      cwd,
      { ...options, signal },
    );
  }

  async codexControlContext(cwd: string): Promise<CodexControlContext> {
    let executable = this.resolvedCommands.get("codex");
    if (!executable) executable = (await this.detect("codex")).executable;
    if (!executable) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "Codex CLI is not installed.",
      );
    }
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    return {
      executable,
      environment: providerChildEnvironment("codex", environment.env),
      cwd,
    };
  }

  async claudeSkills(
    cwd: string,
    forceReload: boolean,
  ): Promise<Awaited<ReturnType<typeof readClaudeAgentSdkSkills>>> {
    let executable = this.resolvedCommands.get("claude");
    if (!executable) executable = (await this.detect("claude")).executable;
    if (!executable) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "Claude CLI is not installed.",
      );
    }
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    return await readClaudeAgentSdkSkills(
      executable,
      providerChildEnvironment("claude", environment.env),
      cwd,
      forceReload,
    );
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks = {}): Promise<ProviderRunResult> {
    const conversationId = validateProviderRunInput(input);
    if (this.activeRuns.has(conversationId)) {
      throw new ProviderRuntimeError("already_running", "This conversation already has an active provider run.");
    }

    const providerId = input.providerId;
    const runId = input.runId ?? conversationId;
    const turnId = input.turnId ?? null;
    const executable = this.commandFor(providerId);
    if (!this.resolvedCommands.has(providerId)) this.resolvedCommands.set(providerId, executable);
    const nativeProfile = nativeBackendProfile(providerId);
    const ownsLegacyProviderMetadata = input.backendProfile.id === nativeProfile.id
      && input.backendProfile.configurationRevision === nativeProfile.configurationRevision;
    const runMetadataScope = this.metadataCache.scopeForSelection(
      input.modelSelection,
      input.backendProfile,
      executable,
    );
    const managerCallbacks: ProviderRunCallbacks = {
      ...callbacks,
      onMetadata: (event) => {
        this.metadataCache.learnScoped(
          runMetadataScope,
          event.metadata,
          event.source,
          { merge: !event.complete },
        );
        if (ownsLegacyProviderMetadata) {
          this.metadataCache.learn(
            event.providerId,
            this.resolvedCommands.get(event.providerId)
              ?? this.commandFor(event.providerId),
            event.metadata,
            event.source,
            { merge: !event.complete },
          );
        }
        callbacks.onMetadata?.(event);
      },
    };
    const compatibilityEmitter = createProviderEmitter(
      providerId,
      conversationId,
      managerCallbacks,
      runId,
      turnId,
    );
    const harness = this.harnessRegistry.resolve(input);
    const baseEnvironment = providerChildEnvironment(
      providerId,
      this.processEnvironment ?? process.env,
    );
    let launchOptions: ProviderBackendLaunchOptions = {
      environment: baseEnvironment,
    };
    let launchDisposed = false;
    let launchReleased = false;
    const releaseLaunch = (): void => {
      if (launchReleased) return;
      launchReleased = true;
      try {
        launchOptions.releaseAfterStart?.();
      } catch {
        // Clearing the resolver-owned copy is best effort and idempotent.
      }
    };
    const disposeLaunch = (): void => {
      if (launchDisposed) return;
      launchDisposed = true;
      try {
        launchOptions.dispose?.();
      } catch {
        // Cleanup is best effort and must never mask the provider result.
      }
    };
    let active!: ActiveRun;
    const settle = (): void => {
      if (active.settled) return;
      active.settled = true;
      active.launchAbort.abort();
      compatibilityEmitter.close();
      disposeLaunch();
      if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
      if (this.activeRuns.get(conversationId) === active) {
        this.activeRuns.delete(conversationId);
      }
      active.resolveLifecycleSettlement();
    };
    const cancelledBeforeStart = (): ProviderRunResult => {
      compatibilityEmitter.status("cancelled");
      return {
        providerId,
        conversationId,
        status: "cancelled",
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        cleanupConfirmed: true,
      };
    };
    const startHarness = (
      resolvedLaunchOptions: ProviderBackendLaunchOptions,
    ): Promise<ProviderRunResult> => {
      launchOptions = resolvedLaunchOptions;
      if (active.cancelRequested || active.settled) {
        releaseLaunch();
        disposeLaunch();
        return Promise.resolve(cancelledBeforeStart());
      }
      let harnessRun: AgentHarnessRun;
      try {
        if (
          launchOptions.harnessConfiguration?.kind === "codex-responses"
          && harness.id !== "codex-app-server"
        ) {
          throw new ProviderRuntimeError(
            "invalid_input",
            "Codex backend configuration was supplied to a different harness.",
          );
        }
        const launchInput = launchOptions.modelArgument === undefined
          ? input
          : {
              ...input,
              model: launchOptions.modelArgument ?? undefined,
            };
        active.harnessStartInvoked = true;
        harnessRun = harness.start({
          input: launchInput,
          executable,
          // The harness owns this copy for the lifetime of its child process.
          // The resolver-owned source is scrubbed immediately below.
          environment: { ...launchOptions.environment },
          ...(launchOptions.harnessConfiguration
            ? { harnessConfiguration: launchOptions.harnessConfiguration }
            : {}),
          callbacks: providerCallbacksFromHarness(compatibilityEmitter),
          ...(callbacks.hostTools ? { hostTools: callbacks.hostTools } : {}),
        });
      } finally {
        releaseLaunch();
      }
      active.harnessRun = harnessRun;
      if (harnessRun.harnessId !== harness.id || harnessRun.providerId !== providerId) {
        try {
          harnessRun.cancel(true);
        } catch {
          // A malformed harness may already have stopped while returning its run.
        }
        disposeLaunch();
        throw new ProviderRuntimeError("invalid_input", `Agent harness '${harness.id}' returned a mismatched run.`);
      }
      if (active.cancelRequested) {
        this.cancelStartedHarness(active);
      } else {
        try {
          callbacks.onStarted?.();
        } catch {
          // Start acknowledgement observers cannot invalidate an owned run.
        }
      }
      return harnessRun.result;
    };

    const launchAbort = new AbortController();
    let resolveLifecycleSettlement!: () => void;
    const lifecycleSettlement = new Promise<void>((resolve) => {
      resolveLifecycleSettlement = resolve;
    });
    active = {
      result: Promise.resolve(null as never),
      lifecycleSettlement,
      resolveLifecycleSettlement,
      harnessRun: null,
      harnessStartInvoked: false,
      launchAbort,
      markPendingCancellation: () => compatibilityEmitter.status("cancelling"),
      runId,
      turnId,
      processCleanupConfirmed: false,
      cancelRequested: false,
      settled: false,
      detach: settle,
      quarantine: () => {
        active.cancelRequested = true;
        compatibilityEmitter.close();
      },
    };
    this.activeRuns.set(conversationId, active);

    let launched: Promise<ProviderRunResult>;
    try {
      const resolved = this.resolveBackendLaunchOptions?.(
        input,
        baseEnvironment,
        { signal: launchAbort.signal },
      ) ?? launchOptions;
      launched = isPromiseLike(resolved)
        ? Promise.resolve(resolved).then(
            startHarness,
            (error: unknown) => {
              if (active.cancelRequested) return cancelledBeforeStart();
              throw error;
            },
          )
        : startHarness(resolved);
    } catch (error) {
      if (!active.harnessStartInvoked) {
        active.processCleanupConfirmed = true;
        settle();
      }
      else active.cancelRequested = true;
      throw error;
    }
    const result = launched.then(
      (value) => {
        if (!value.cleanupConfirmed) {
          active.cancelRequested = true;
          compatibilityEmitter.close();
          if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
        } else {
          active.processCleanupConfirmed = true;
          settle();
        }
        return value;
      },
      (error: unknown) => {
        if (!active.harnessStartInvoked) {
          active.processCleanupConfirmed = true;
          settle();
        }
        else active.cancelRequested = true;
        throw error;
      },
    );
    active.result = result;
    return result;
  }

  compact(
    input: ProviderRunInput,
    instruction?: string,
    callbacks: ProviderRunCallbacks = {},
  ): Promise<ProviderCompactionResult> {
    const operationInput: ProviderRunInput = {
      ...input,
      prompt: "/compact",
      // Context compaction is a turnless control operation, never a user turn
      // with authority to execute tools. Force interactive policy even when
      // the conversation normally runs with elevated access so every provider
      // approval/input reaches the fail-closed callbacks below.
      access: "supervised",
      operation: {
        kind: "compact",
        ...(instruction ? { instruction } : {}),
      },
    };
    const instructionForwarded = (
      operationInput.providerId === "claude"
      || operationInput.providerId === "kimi"
    )
      && instruction !== undefined;
    let interactionError: string | undefined;
    const rejectInteractiveCompaction = (
      interaction: "approval" | "input",
    ): void => {
      if (interactionError) return;
      interactionError = `Provider compaction requested interactive ${interaction} that a turnless operation cannot answer.`;
      this.cancel(input.conversationId ?? input.threadId ?? "");
    };
    const providerResult = this.run(operationInput, {
      ...callbacks,
      onApproval: () => rejectInteractiveCompaction("approval"),
      onInput: () => rejectInteractiveCompaction("input"),
    });
    const timer = setTimeout(() => {
      this.cancel(input.conversationId ?? input.threadId ?? "");
    }, PROVIDER_COMPACTION_OPERATION_TIMEOUT_MS);
    timer.unref();
    return providerResult.then((result) => {
      const requestedSessionId = operationInput.sessionId!;
      const sessionError = result.sessionId === requestedSessionId
        ? undefined
        : "The provider did not confirm compaction of the exact selected session.";
      const operationError = interactionError ?? sessionError;
      const status = operationError ? "failed" as const : result.status;
      const error = operationError ?? result.error;
      const message = status !== "completed"
        ? error ?? "The provider could not compact this chat."
        : instruction && !instructionForwarded
          ? `${PROVIDER_INFO[result.providerId].name} compacted the context, but does not accept a focus instruction through this integration, so the instruction was not forwarded.`
          : instructionForwarded
            ? "Context compacted with the focus instruction."
            : "Context compacted.";
      return {
        providerId: result.providerId,
        conversationId: result.conversationId,
        status,
        instructionForwarded,
        message,
        ...(error ? { error } : {}),
        cleanupConfirmed: result.cleanupConfirmed,
      };
    }).finally(() => clearTimeout(timer));
  }

  cancel(conversationId: string): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested) return false;
    active.cancelRequested = true;
    if (!active.harnessRun) {
      active.markPendingCancellation();
      active.launchAbort.abort();
      return true;
    }
    this.cancelStartedHarness(active);
    return true;
  }

  async steer(
    conversationId: string,
    input: ProviderSteerInput,
    identity: { runId: string; turnId: string },
  ): Promise<boolean> {
    const active = this.activeRuns.get(conversationId);
    if (
      !active
      || active.settled
      || active.cancelRequested
      || active.runId !== identity.runId
      || active.turnId !== identity.turnId
    ) return false;
    const extension = active.harnessRun?.extension;
    const steer = extension && "steer" in extension
      ? extension.steer
      : undefined;
    if (!steer) return false;
    try {
      return await steer(input);
    } catch {
      return false;
    }
  }

  async setGoal(
    conversationId: string,
    input: ProviderGoalMutation,
    identity: { runId: string; turnId: string },
  ): Promise<ProviderGoalSnapshot | null> {
    const active = this.activeRuns.get(conversationId);
    if (
      !active
      || active.settled
      || active.cancelRequested
      || active.runId !== identity.runId
      || active.turnId !== identity.turnId
    ) return null;
    const extension = active.harnessRun?.extension;
    if (!extension || extension.kind !== "codex-app-server") return null;
    return await extension.setGoal(input);
  }

  async clearGoal(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean | "superseded"> {
    const active = this.activeRuns.get(conversationId);
    if (
      !active
      || active.settled
      || active.cancelRequested
      || active.runId !== identity.runId
      || active.turnId !== identity.turnId
    ) return false;
    const extension = active.harnessRun?.extension;
    if (!extension || extension.kind !== "codex-app-server") return false;
    return await extension.clearGoal() ? true : "superseded";
  }

  async stopSubagent(
    conversationId: string,
    providerTaskId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean> {
    const active = this.activeRuns.get(conversationId);
    if (
      !active
      || active.settled
      || active.cancelRequested
      || active.runId !== identity.runId
      || active.turnId !== identity.turnId
    ) return false;
    const extension = active.harnessRun?.extension;
    const stopSubagent = extension && "stopSubagent" in extension
      ? extension.stopSubagent
      : undefined;
    if (!stopSubagent) return false;
    try {
      return await stopSubagent(providerTaskId);
    } catch {
      return false;
    }
  }

  private cancelStartedHarness(active: ActiveRun): void {
    const harnessRun = active.harnessRun;
    if (!harnessRun) return;
    try {
      harnessRun.cancel(false);
    } catch {
      // The provider may already have queued its terminal event.
    }
    active.hardKillTimer = setTimeout(() => {
      if (active.settled) return;
      try {
        harnessRun.cancel(true);
      } catch {
        // The process may have exited between the check and kill.
      }
    }, this.cancelGraceMs);
    active.hardKillTimer.unref();
  }

  /**
   * Stops one caller-owned provider run without allowing a malformed harness
   * result promise to wedge its owner forever. The full identity is required
   * so an auxiliary controller cannot accidentally detach an ordinary
   * resumable conversation that happens to reuse a lookup key.
   */
  async stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string | null },
    graceMs = this.cancelGraceMs,
  ): Promise<OwnedProviderStopResult> {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled) return "missing";
    if (active.runId !== identity.runId || active.turnId !== identity.turnId) {
      return "identity-mismatch";
    }
    if (active.processCleanupConfirmed) {
      active.detach();
      return active.settled ? "settled" : "force-detached";
    }

    this.cancel(conversationId);
    if (await this.waitForSettlement(active, graceMs)) return "settled";

    if (active.hardKillTimer) {
      clearTimeout(active.hardKillTimer);
      active.hardKillTimer = undefined;
    }
    try {
      active.harnessRun?.cancel(true);
    } catch {
      // A malformed harness can throw while its owned process is already gone.
    }
    if (await this.waitForSettlement(active, FORCE_DETACH_GRACE_MS)) return "settled";

    // Exact lifecycle owners can retain this run as a durable in-process
    // exclusion until the harness settles or the runtime supervisor confirms
    // termination of the complete utility-process tree.
    active.quarantine();
    return "force-detached";
  }

  async disposeAll(): Promise<void> {
    this.ownedLifetimeAbort?.abort(
      new Error("The provider manager is shutting down."),
    );
    while (this.auxiliaryOperations.size > 0) {
      await Promise.allSettled(this.auxiliaryOperations);
    }
    const active = [...this.activeRuns.entries()];
    const results = await Promise.allSettled(active.map(([conversationId, run]) =>
      this.stopOwned(
        conversationId,
        { runId: run.runId, turnId: run.turnId },
        undefined,
      )));
    if (
      results.some((result) => (
        result.status === "rejected"
        || (result.value !== "settled" && result.value !== "missing")
      ))
      || this.activeRuns.size > 0
      || this.auxiliaryCleanupUnconfirmed
      || !this.metadataCache.processCleanupConfirmed()
    ) {
      throw new Error("Provider process cleanup could not be confirmed.");
    }
  }

  respondToApproval(
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
    identity?: { runId: string; turnId: string },
  ): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || !active.harnessRun || active.settled || active.cancelRequested) return false;
    if (identity && (active.runId !== identity.runId || active.turnId !== identity.turnId)) return false;
    const extension = active.harnessRun.extension;
    if (!("respondToApproval" in extension)) return false;
    return extension.respondToApproval(requestId, decision);
  }

  respondToInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
    identity?: { runId: string; turnId: string },
  ): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || !active.harnessRun || active.settled || active.cancelRequested) return false;
    if (identity && (active.runId !== identity.runId || active.turnId !== identity.turnId)) return false;
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

  private async waitForSettlement(active: ActiveRun, graceMs: number): Promise<boolean> {
    if (active.settled) return true;
    const boundedGraceMs = Math.max(0, Math.min(graceMs, MAX_OWNED_STOP_GRACE_MS));
    if (boundedGraceMs === 0) return active.settled;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      active.lifecycleSettlement.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedGraceMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return settled;
  }
}
