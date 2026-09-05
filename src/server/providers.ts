import { randomUUID } from "node:crypto";

import type { AgentApprovalDecision } from "./provider/interactions";
import { officiallyAllowsModelSwitchWithinSession } from "../shared/continuation-policy";
import {
  CURSOR_ACP_TERMINAL_RESUME_VERIFIED_VERSION,
  cursorVersionHasVerifiedAcpTerminalResume,
} from "../shared/provider-terminal-resume";
import {
  type BackendCompatibilityProbeResult,
} from "../shared/backend-probe";
import {
  versionedContinuationIdentityForSelection,
  providerIdForHarness,
  modelSelectionSchema,
  modelBackendProfileSchema,
  currentKnownHarnessIdSchema,
  providerNativeBackendProfile,
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
  ProviderCapabilityId,
  ProviderCapabilityManifest,
} from "./provider/capability-manifest";
import type {
  AgentHarnessCapabilities,
  AgentHarnessId,
} from "./provider/agent-harness";
import {
  providerAuthLaunchEnvironment,
  providerAuthLoginArgs,
} from "./provider/auth";
import { PROVIDERS, PROVIDER_INFO } from "./provider/catalog";
import {
  PROVIDER_IDS,
  ProviderRuntimeError,
  type ProviderAuthLaunch,
  type ProviderDetection,
  type ProviderDetectionOptions,
  type ProviderId,
  type ProviderInstallationUseTransfer,
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
  ProviderMetadataCache,
  type ProviderMetadata,
  type ProviderMetadataRequestOptions,
} from "./provider/metadata";
import { readClaudeAgentSdkSkills } from "./provider/claude-agent-sdk-harness";
import {
  canonicalProviderExecutable,
  ProviderInstallationAdmissionError,
  ProviderInstallationLeaseCoordinator,
  type ProviderInstallationIdentity,
  type ProviderInstallationVerificationAuthority,
} from "./provider/installation-lease";
import {
  ProviderManagerInstallationAuthority,
} from "./provider/provider-manager-installation";
import { ProviderCapabilityAuthority } from
  "./provider/provider-capability-authority";
import {
  admittedCustomBackendCapabilities,
  admittedCustomBackendProbeEvidence,
  recordBackendProbeEvidence,
} from
  "./provider/custom-backend-probe-admission";
import { providerProcessInvocation, providerPtyArguments } from "./provider/process";
import { isProcessTreeTerminationUnconfirmed } from "./process-lifecycle";
import {
  ProviderRunCoordinator,
  type OwnedProviderStopResult,
} from "./provider/run-coordinator";
import {
  providerTerminalResumeLaunch,
  type ProviderTerminalResumeLaunch,
} from "./provider/terminal-resume";

export { PROVIDERS, PROVIDER_INFO, PROVIDER_IDS, ProviderRuntimeError, detectProvider, detectProviders };
export { AgentHarnessRegistry, createDefaultAgentHarnessRegistry };
export type { OwnedProviderStopResult } from "./provider/run-coordinator";
export type * from "./provider/agent-harness";
export type * from "./provider/contracts";
const DEFAULT_CANCEL_GRACE_MS = 2_000;
const PRODUCTION_MANAGER_CONSTRUCTION = Symbol("production-provider-manager");
const TEST_MANAGER_CONSTRUCTION = Symbol("test-provider-manager");
type ProviderManagerConstructionAuthority =
  | typeof PRODUCTION_MANAGER_CONSTRUCTION
  | typeof TEST_MANAGER_CONSTRUCTION;

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
  installationUse: ProviderInstallationUseTransfer;
}

export interface ProviderInstallationReadContext {
  /** Exact process-local authority issued only after a maintenance command. */
  installationVerificationAuthority?: ProviderInstallationVerificationAuthority;
}

export type ProviderManagerDetectionOptions = Omit<
  ProviderDetectionOptions,
  "command"
> & ProviderInstallationReadContext;

export type ProviderManagerMetadataRequestOptions =
  ProviderMetadataRequestOptions & ProviderInstallationReadContext;

type ProviderManagerConstructionOptions = ProviderManagerOptions & {
  metadataCache?: ProviderMetadataCache;
  detectProvider?: typeof detectProvider;
  installationLeases?: ProviderInstallationLeaseCoordinator;
  installationOperationId?: () => string;
};

export type ProductionProviderManagerOptions =
  ProviderManagerConstructionOptions & {
    installationLeases: ProviderInstallationLeaseCoordinator;
  };

export class ProviderManager {
  private readonly commands: Partial<Record<ProviderId, string>>;
  private readonly resolvedCommands = new Map<ProviderId, string>();
  private readonly cancelGraceMs: number;
  private readonly harnessRegistry: AgentHarnessRegistry;
  private readonly metadataCache: ProviderMetadataCache;
  private readonly detectProviderImplementation: typeof detectProvider;
  private readonly lifetimeSignal: AbortSignal;
  private readonly ownedLifetimeAbort?: AbortController;
  private readonly auxiliaryOperations = new Set<Promise<unknown>>();
  private readonly backendProfiles = new Map<string, ModelBackendProfile>();
  private readonly backendCompatibilities = new Map<string, HarnessBackendCompatibility>();
  private readonly backendProbeResults = new Map<string, BackendCompatibilityProbeResult>();
  private readonly backendProbeNow: () => Date;
  private readonly protectedBackendProfileIds = new Set<string>();
  private readonly resolveBackendLaunchOptions: ProviderManagerOptions["resolveBackendLaunchOptions"];
  private readonly installationLeases?: ProviderInstallationLeaseCoordinator;
  private readonly installationAuthority: ProviderManagerInstallationAuthority;
  private readonly capabilityAuthority: ProviderCapabilityAuthority;
  private readonly runCoordinator: ProviderRunCoordinator;
  private processEnvironment: NodeJS.ProcessEnv | undefined;
  private auxiliaryCleanupUnconfirmed = false;

  static createProduction(
    options: ProductionProviderManagerOptions,
    harnessRegistry: AgentHarnessRegistry = createDefaultAgentHarnessRegistry(),
  ): ProviderManager {
    if (!options.installationLeases) {
      throw new Error(
        "Production ProviderManager construction requires installation authority.",
      );
    }
    return new ProviderManager(
      options,
      harnessRegistry,
      PRODUCTION_MANAGER_CONSTRUCTION,
    );
  }

  /**
   * Explicit compatibility seam for isolated tests that do not model provider
   * installation ownership. It cannot be used by a non-test runtime.
   */
  static createForTests(
    options: ProviderManagerConstructionOptions = {},
    harnessRegistry: AgentHarnessRegistry = createDefaultAgentHarnessRegistry(),
  ): ProviderManager {
    if (process.env.NODE_ENV !== "test") {
      throw new Error(
        "ProviderManager.createForTests is available only in a test runtime.",
      );
    }
    return new ProviderManager(
      options,
      harnessRegistry,
      TEST_MANAGER_CONSTRUCTION,
    );
  }

  private constructor(
    options: ProviderManagerConstructionOptions,
    harnessRegistry: AgentHarnessRegistry,
    constructionAuthority: ProviderManagerConstructionAuthority,
  ) {
    if (
      constructionAuthority !== PRODUCTION_MANAGER_CONSTRUCTION
      && constructionAuthority !== TEST_MANAGER_CONSTRUCTION
    ) {
      throw new Error("ProviderManager construction authority is invalid.");
    }
    if (
      constructionAuthority === PRODUCTION_MANAGER_CONSTRUCTION
      && !options.installationLeases
    ) {
      throw new Error(
        "Production ProviderManager construction requires installation authority.",
      );
    }
    this.commands = { ...options.commands };
    this.cancelGraceMs = Math.max(100, Math.min(options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS, 30_000));
    this.harnessRegistry = harnessRegistry;
    this.metadataCache = options.metadataCache ?? new ProviderMetadataCache();
    this.detectProviderImplementation = options.detectProvider ?? detectProvider;
    this.backendProbeNow = options.backendProbeNow ?? (() => new Date());
    this.installationLeases = options.installationLeases;
    this.installationAuthority = new ProviderManagerInstallationAuthority({
      leases: this.installationLeases,
      metadataCache: this.metadataCache,
      operationId: options.installationOperationId ?? randomUUID,
      configuredBoundary: (providerId) =>
        this.configuredInstallationBoundary(providerId),
      invalidateEvidence: (providerId) =>
        this.invalidateInstallationEvidence(providerId),
    });
    this.capabilityAuthority = new ProviderCapabilityAuthority({
      metadataCache: this.metadataCache,
      resolvedExecutable: (providerId) =>
        this.resolvedCommands.get(providerId),
      installationFingerprint: (providerId, executable, version) =>
        this.installationAuthority.identity(
          providerId,
          executable,
          providerNativeBackendProfile(providerId),
          version,
        ).fingerprint,
      customProbeCapabilities: (providerId, backendProfile, modelId) => {
        const probe = this.backendProbeResults.get(
          `${backendProfile.id}\0${modelId}`,
        );
        return admittedCustomBackendProbeEvidence(
          probe,
          backendProfile,
          modelId,
          this.backendProbeNow(),
          this.capabilityAuthority.installationFingerprint(providerId),
        );
      },
      evidenceTrusted: () => !this.installationAuthority.uncertain
        && !this.auxiliaryCleanupUnconfirmed
        && this.metadataCache.processCleanupConfirmed(),
    });
    this.ownedLifetimeAbort = options.lifetimeSignal
      ? undefined
      : new AbortController();
    this.lifetimeSignal = options.lifetimeSignal
      ?? this.ownedLifetimeAbort!.signal;
    this.resolveBackendLaunchOptions = options.resolveBackendLaunchOptions;
    this.runCoordinator = new ProviderRunCoordinator({
      cancelGraceMs: this.cancelGraceMs,
      harnessRegistry: this.harnessRegistry,
      metadataCache: this.metadataCache,
      resolveBackendLaunchOptions: this.resolveBackendLaunchOptions,
      commandFor: (providerId) => this.commandFor(providerId),
      resolvedCommandFor: (providerId) => this.resolvedCommands.get(providerId),
      rememberResolvedCommand: (providerId, executable) => {
        this.resolvedCommands.set(providerId, executable);
      },
      processEnvironment: () => this.processEnvironment,
      capabilityAvailable: (input, capabilityId, configured, negotiated) =>
        this.installationLeases
          ? this.capabilityAuthority.available(
              input,
              capabilityId,
              configured,
              negotiated ?? [],
            )
          : this.testManagerCapabilityAvailable(input, capabilityId),
      capabilityAdmissible: (input, capabilityId, configured) =>
        this.installationLeases
          ? this.capabilityAuthority.admissible(
              input,
              capabilityId,
              configured,
            )
          : this.testManagerCapabilityAvailable(input, capabilityId),
      acquireInstallationUse: (input, executable) => {
        const admission = this.installationAuthority.acquire(
          input.providerId,
          executable,
          input.backendProfile,
          "provider-run",
          input.runId,
        );
        return {
          release: () => this.installationAuthority.release(admission),
          quarantine: (reason) => {
            this.installationAuthority.quarantine(admission, reason);
          },
        };
      },
    });
    for (const providerId of PROVIDER_IDS) {
      const profile = providerNativeBackendProfile(providerId);
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
    return this.runCoordinator.isRunning(conversationId);
  }

  ownsRun(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): boolean {
    return this.runCoordinator.ownsRun(conversationId, identity);
  }

  activeConversationIds(): string[] {
    return this.runCoordinator.activeConversationIds();
  }

  harnessCapabilities(providerId?: ProviderId): readonly AgentHarnessCapabilities[] {
    return this.harnessRegistry.capabilities(providerId);
  }

  providerCapabilityManifests(
    providerId?: ProviderId,
  ): readonly ProviderCapabilityManifest[] {
    return this.harnessRegistry.capabilityManifests(providerId);
  }

  providerCapabilityContract(
    providerId: ProviderId,
  ) {
    return this.capabilityAuthority.contract(providerId);
  }

  providerInstallationFingerprint(providerId: ProviderId): string | null {
    return this.capabilityAuthority.installationFingerprint(providerId);
  }

  providerMaintenanceCapabilityAvailable(
    providerId: ProviderId,
    executable: string | null,
    updateActionVerified: boolean,
  ): boolean {
    return this.capabilityAuthority.maintenanceAvailable(
      providerId,
      executable,
      updateActionVerified,
    );
  }

  harnessIdFor(input: ProviderRunInput): AgentHarnessId {
    validateProviderRunInput(input);
    return this.harnessRegistry.resolve(input).id;
  }

  providerCapabilityAvailable(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
    configured: readonly ProviderCapabilityId[] = [],
  ): boolean {
    return this.capabilityAuthority.available(
      input,
      capabilityId,
      configured,
    );
  }

  providerCapabilityAdmissible(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
    configured: readonly ProviderCapabilityId[] = [],
  ): boolean {
    return this.capabilityAuthority.admissible(
      input,
      capabilityId,
      configured,
    );
  }

  recordBackendProbeResult(resultInput: BackendCompatibilityProbeResult): void {
    recordBackendProbeEvidence(
      this.backendProbeResults,
      this.backendProfiles,
      resultInput,
      this.backendProbeNow(),
    );
  }

  /**
   * Test construction bypasses executable attestation, never custom-route
   * capability evidence. This keeps focused harness tests convenient without
   * creating a tool-authority path that exists only under test.
   */
  private testManagerCapabilityAvailable(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
  ): boolean {
    if (input.backendProfile.source !== "custom") return true;
    // Preserve the test factory's general executable-attestation bypass, but
    // never bypass the pre-execution custom-route gates under audit.
    if (capabilityId === "host-tool-bridge" || capabilityId === "plans") {
      return false;
    }
    if (
      capabilityId !== "text-streaming"
      && capabilityId !== "provider-native-tools"
      && capabilityId !== "tool-activity"
    ) return true;
    const probe = this.backendProbeResults.get(
      `${input.backendProfile.id}\0${input.modelSelection.modelId}`,
    );
    return admittedCustomBackendCapabilities(
      probe,
      input.backendProfile,
      input.modelSelection.modelId,
      this.backendProbeNow(),
      this.capabilityAuthority.installationFingerprint(input.providerId),
    )
      .includes(capabilityId);
  }

  upsertBackendProfile(
    profileInput: ModelBackendProfile,
    ownerProviderId?: ProviderId,
  ): void {
    const profile = modelBackendProfileSchema.parse(profileInput);
    if (ownerProviderId) {
      this.assertProviderConfigurationMutable(ownerProviderId);
    }
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

  removeBackendProfile(profileId: string, ownerProviderId?: ProviderId): void {
    const current = this.backendProfiles.get(profileId);
    if (!current) return;
    if (ownerProviderId) {
      this.assertProviderConfigurationMutable(ownerProviderId);
    }
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
    const harnessId = currentKnownHarnessIdSchema.safeParse(selection.harnessId);
    const providerId = providerIdForHarness(selection.harnessId);
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
          evaluatedAt: this.backendProbeNow(),
          modelId: selection.modelId,
          probe,
        })
      : explicit ?? resolveHarnessBackendCompatibility(
          harnessId.data,
          backendProfile,
          {
            evaluatedAt: this.backendProbeNow(),
            modelId: selection.modelId,
            probe,
          },
        );
    const providerCompatibilityToken = this.capabilityAuthority.continuationToken(
      providerId,
      harnessId.data,
      backendProfile,
      compatibility,
      selection.modelId,
    );
    return {
      providerId,
      harnessId: harnessId.data,
      backendProfile,
      compatibility,
      continuationIdentity: versionedContinuationIdentityForSelection(
        selection,
        backendProfile.endpointIdentity,
        !officiallyAllowsModelSwitchWithinSession(compatibility),
        providerCompatibilityToken,
      ),
    };
  }

  providerInstallationIdentityForMaintenance(
    providerId: ProviderId,
    executable: string | null,
    version: string | null,
  ): ProviderInstallationIdentity {
    return this.installationAuthority.identity(
      providerId,
      executable ?? this.commandFor(providerId),
      providerNativeBackendProfile(providerId),
      version,
    );
  }

  invalidateInstallationEvidence(providerId: ProviderId): void {
    this.capabilityAuthority.invalidate(providerId);
    this.resolvedCommands.delete(providerId);
    this.metadataCache.correlate(providerId, {
      executable: null,
      version: null,
      authState: "unknown",
    });
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
    options: ProviderManagerDetectionOptions = {},
  ): Promise<ProviderDetection> {
    return this.trackAuxiliary(async () =>
      await this.detectProviderInfo(providerId, options));
  }

  private async detectProviderInfo(
    providerId: ProviderId,
    options: ProviderManagerDetectionOptions,
  ): Promise<ProviderDetection> {
    const {
      installationVerificationAuthority,
      ...detectionOptions
    } = options;
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    if (detectionOptions.refreshEnvironment) await providerEnvironment(true);
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    const environment = await providerEnvironment();
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    this.processEnvironment = environment.env;
    const configured = this.commands[providerId]?.trim() || PROVIDER_INFO[providerId].command;
    const resolvedExecutable = this.resolvedCommands.get(providerId);
    const cachedExecutable = this.metadataCache.nativeScope(providerId).executable;
    const admissionExecutable = resolvedExecutable ?? cachedExecutable ?? configured;
    const allowUnboundInitialResolution = !resolvedExecutable
      && !cachedExecutable
      && canonicalProviderExecutable(configured) === null;
    const backendProfile = providerNativeBackendProfile(providerId);
    const admission = this.installationAuthority.acquire(
      providerId,
      admissionExecutable,
      backendProfile,
      "compatibility-probe",
      this.installationAuthority.operationIdentity(
        "compatibility-probe",
        installationVerificationAuthority,
      ),
      installationVerificationAuthority,
    );
    let detection: ProviderDetection;
    try {
      detection = await this.detectProviderImplementation(providerId, {
        ...detectionOptions,
        refreshEnvironment: false,
        command: configured,
        signal: this.lifetimeSignal,
      });
    } catch (error) {
      const cleanupUnconfirmed = isProcessTreeTerminationUnconfirmed(error);
      if (cleanupUnconfirmed) {
        this.installationAuthority.quarantine(
          admission,
          "provider-discovery-cleanup-unconfirmed",
        );
      } else {
        this.installationAuthority.release(admission);
      }
      this.auxiliaryCleanupUnconfirmed ||= cleanupUnconfirmed;
      this.invalidateInstallationEvidence(providerId);
      throw error;
    }
    try {
      this.installationAuthority.settleDetection(
        admission,
        detection,
        backendProfile,
        installationVerificationAuthority,
        allowUnboundInitialResolution,
      );
    } catch (error) {
      this.invalidateInstallationEvidence(providerId);
      throw error;
    }
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    this.auxiliaryCleanupUnconfirmed ||= !detection.cleanupConfirmed;
    if (detection.executable && detection.cleanupConfirmed) {
      this.resolvedCommands.set(providerId, detection.executable);
    } else {
      this.resolvedCommands.delete(providerId);
    }
    this.metadataCache.correlate(providerId, {
      executable: detection.executable ?? null,
      version: detection.cleanupConfirmed
        ? detection.version ?? null
        : null,
      authState: detection.authState,
    });
    this.capabilityAuthority.rememberDetection(detection);
    return detection;
  }

  validateCommand(
    providerId: ProviderId,
    command: string,
    options: ProviderManagerDetectionOptions = {},
  ): Promise<ProviderDetection> {
    return this.trackAuxiliary(async () =>
      await this.validateProviderCommand(providerId, command, options));
  }

  private async validateProviderCommand(
    providerId: ProviderId,
    command: string,
    options: ProviderManagerDetectionOptions,
  ): Promise<ProviderDetection> {
    const {
      installationVerificationAuthority,
      ...detectionOptions
    } = options;
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    const backendProfile = providerNativeBackendProfile(providerId);
    const admission = this.installationAuthority.acquire(
      providerId,
      command,
      backendProfile,
      "compatibility-probe",
      this.installationAuthority.operationIdentity(
        "compatibility-probe",
        installationVerificationAuthority,
      ),
      installationVerificationAuthority,
    );
    let detection: ProviderDetection;
    try {
      detection = await this.detectProviderImplementation(providerId, {
        ...detectionOptions,
        command,
        signal: this.lifetimeSignal,
      });
    } catch (error) {
      const cleanupUnconfirmed = isProcessTreeTerminationUnconfirmed(error);
      if (cleanupUnconfirmed) {
        this.installationAuthority.quarantine(
          admission,
          "provider-validation-cleanup-unconfirmed",
        );
      } else {
        this.installationAuthority.release(admission);
      }
      this.auxiliaryCleanupUnconfirmed ||= cleanupUnconfirmed;
      throw error;
    }
    this.installationAuthority.settleDetection(
      admission,
      detection,
      backendProfile,
      installationVerificationAuthority,
    );
    if (this.lifetimeSignal.aborted) {
      throw new Error("Provider discovery was cancelled.");
    }
    this.auxiliaryCleanupUnconfirmed ||= !detection.cleanupConfirmed;
    return detection;
  }

  setCommand(providerId: ProviderId, command?: string): void {
    this.assertProviderConfigurationMutable(providerId);
    const value = command?.trim();
    if (value) this.commands[providerId] = value;
    else delete this.commands[providerId];
    this.resolvedCommands.delete(providerId);
    this.capabilityAuthority.invalidate(providerId);
    this.metadataCache.invalidate(providerId);
  }

  assertProviderConfigurationMutable(providerId: ProviderId): void {
    if (!this.installationLeases?.hasProviderAuthority(providerId)) return;
    throw new ProviderInstallationAdmissionError(
      "Provider configuration cannot change while its installation is owned.",
      [],
    );
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
    const childEnvironment = providerAuthLaunchEnvironment(
      providerId,
      providerChildEnvironment(providerId, environment.env),
    );
    const invocation = providerProcessInvocation(
      executable,
      providerAuthLoginArgs(providerId),
      childEnvironment,
    );
    const installationUse = this.installationAuthority.acquire(
      providerId,
      executable,
      providerNativeBackendProfile(providerId),
      "auth-discovery",
      this.installationAuthority.operationIdentity("auth-discovery"),
    );
    return {
      executable: invocation.command,
      args: providerPtyArguments(invocation),
      env: childEnvironment,
      installationUse: this.installationAuthority.transfer(installationUse),
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
      const launch = providerTerminalResumeLaunch(
        detection.executable,
        providerId,
        sessionId,
        childEnvironment,
      );
      const installationUse = this.installationAuthority.acquire(
        providerId,
        detection.executable,
        providerNativeBackendProfile(providerId),
        "provider-server",
        this.installationAuthority.operationIdentity("provider-server"),
      );
      return {
        ...launch,
        installationUse: this.installationAuthority.transfer(installationUse),
      };
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
    options: ProviderManagerMetadataRequestOptions = {},
  ): Promise<ProviderMetadata> {
    return this.trackAuxiliary(async () =>
      await this.readMetadata(providerId, cwd, options));
  }

  private async readMetadata(
    providerId: ProviderId,
    cwd: string,
    options: ProviderManagerMetadataRequestOptions,
  ): Promise<ProviderMetadata> {
    const {
      installationVerificationAuthority,
      ...metadataOptions
    } = options;
    const signal = this.lifetimeSignal;
    if (signal.aborted) return this.metadataCache.current(providerId);
    let executable = this.resolvedCommands.get(providerId);
    if (!executable) executable = (await this.detect(providerId, {
      signal,
      ...(installationVerificationAuthority
        ? { installationVerificationAuthority }
        : {}),
    })).executable;
    if (!executable) return this.metadataCache.current(providerId);
    const environment = await providerEnvironment();
    if (signal.aborted) return this.metadataCache.current(providerId);
    this.processEnvironment = environment.env;
    const admission = this.installationAuthority.acquire(
      providerId,
      executable,
      providerNativeBackendProfile(providerId),
      "metadata-discovery",
      this.installationAuthority.operationIdentity(
        "metadata-discovery",
        installationVerificationAuthority,
      ),
      installationVerificationAuthority,
    );
    let metadata: ProviderMetadata;
    try {
      metadata = await this.metadataCache.metadata(
        providerId,
        executable,
        providerChildEnvironment(providerId, environment.env),
        cwd,
        { ...metadataOptions, signal },
      );
    } catch (error) {
      this.installationAuthority.quarantine(
        admission,
        "provider-metadata-terminal-outcome-unavailable",
      );
      throw error;
    }
    if (!this.metadataCache.processCleanupConfirmed()) {
      this.installationAuthority.quarantine(
        admission,
        "provider-metadata-cleanup-unconfirmed",
      );
      return metadata;
    }
    if (!this.installationAuthority.release(admission)) {
      throw new ProviderRuntimeError(
        "lifecycle_corruption",
        "Provider metadata could not release exact installation authority.",
      );
    }
    return metadata;
  }

  async verifyInstallationConformance(
    providerId: ProviderId,
    cwd: string,
    authority: ProviderInstallationVerificationAuthority,
  ): Promise<ProviderInstallationIdentity> {
    if (authority.providerId !== providerId) {
      throw new ProviderRuntimeError(
        "lifecycle_corruption",
        "Provider installation verification authority has the wrong owner.",
      );
    }
    const context = { installationVerificationAuthority: authority };
    const detection = await this.detect(providerId, {
      ...context,
      cwd,
      refreshEnvironment: true,
      probeAuthentication: true,
    });
    if (
      !detection.available
      || !detection.canRun
      || !detection.executable
      || !detection.version
      || !detection.cleanupConfirmed
    ) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "The provider installation failed its native protocol conformance probe.",
      );
    }
    await this.metadata(providerId, cwd, { ...context, force: true });
    if (!this.providerCapabilityContract(providerId).installationVerified) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "The provider installation could not produce a verified capability contract.",
      );
    }
    return this.installationAuthority.identity(
      providerId,
      detection.executable,
      providerNativeBackendProfile(providerId),
      detection.version,
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
      installationUse: this.installationAuthority.transfer(
        this.installationAuthority.acquire(
          "codex",
          executable,
          providerNativeBackendProfile("codex"),
          "provider-server",
          this.installationAuthority.operationIdentity("provider-server"),
        ),
      ),
    };
  }

  async claudeSkills(
    cwd: string,
    forceReload: boolean,
    context: ProviderInstallationReadContext = {},
  ): Promise<Awaited<ReturnType<typeof readClaudeAgentSdkSkills>>> {
    let executable = this.resolvedCommands.get("claude");
    if (!executable) executable = (await this.detect("claude", context)).executable;
    if (!executable) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "Claude CLI is not installed.",
      );
    }
    const environment = await providerEnvironment();
    this.processEnvironment = environment.env;
    const authority = context.installationVerificationAuthority;
    const admission = this.installationAuthority.acquire(
      "claude",
      executable,
      providerNativeBackendProfile("claude"),
      "metadata-discovery",
      this.installationAuthority.operationIdentity("metadata-discovery", authority),
      authority,
    );
    try {
      const skills = await readClaudeAgentSdkSkills(
        executable,
        providerChildEnvironment("claude", environment.env),
        cwd,
        forceReload,
      );
      if (!this.installationAuthority.release(admission)) {
        throw new ProviderRuntimeError(
          "lifecycle_corruption",
          "Claude skill discovery could not release exact installation authority.",
        );
      }
      return skills;
    } catch (error) {
      this.installationAuthority.quarantine(
        admission,
        "claude-skill-discovery-cleanup-unconfirmed",
      );
      throw error;
    }
  }

  run(
    input: ProviderRunInput,
    callbacks: ProviderRunCallbacks = {},
  ): Promise<ProviderRunResult> {
    return this.runCoordinator.run(input, callbacks);
  }

  compact(
    input: ProviderRunInput,
    instruction?: string,
    callbacks: ProviderRunCallbacks = {},
  ): Promise<ProviderCompactionResult> {
    return this.runCoordinator.compact(input, instruction, callbacks);
  }

  cancel(conversationId: string): boolean {
    return this.runCoordinator.cancel(conversationId);
  }

  steer(
    conversationId: string,
    input: ProviderSteerInput,
    identity: { runId: string; turnId: string },
  ): Promise<boolean> {
    return this.runCoordinator.steer(conversationId, input, identity);
  }

  setGoal(
    conversationId: string,
    input: ProviderGoalMutation,
    identity: { runId: string; turnId: string },
  ): Promise<ProviderGoalSnapshot | null> {
    return this.runCoordinator.setGoal(conversationId, input, identity);
  }

  clearGoal(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean | "superseded"> {
    return this.runCoordinator.clearGoal(conversationId, identity);
  }

  stopSubagent(
    conversationId: string,
    providerTaskId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean> {
    return this.runCoordinator.stopSubagent(
      conversationId,
      providerTaskId,
      identity,
    );
  }

  stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string },
    graceMs = this.cancelGraceMs,
  ): Promise<OwnedProviderStopResult> {
    return this.runCoordinator.stopOwned(conversationId, identity, graceMs);
  }

  async disposeAll(): Promise<void> {
    this.ownedLifetimeAbort?.abort(
      new Error("The provider manager is shutting down."),
    );
    while (this.auxiliaryOperations.size > 0) {
      await Promise.allSettled(this.auxiliaryOperations);
    }
    const runCleanupConfirmed = await this.runCoordinator.disposeAll();
    if (
      !runCleanupConfirmed
      || this.auxiliaryCleanupUnconfirmed
      || this.installationAuthority.uncertain
      || !this.metadataCache.processCleanupConfirmed()
    ) {
      throw new Error("Provider process cleanup could not be confirmed.");
    }
  }

  respondToApproval(
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
    identity: { runId: string; turnId: string },
  ): boolean {
    return this.runCoordinator.respondToApproval(
      conversationId,
      requestId,
      decision,
      identity,
    );
  }

  respondToInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
    identity: { runId: string; turnId: string },
  ): boolean {
    return this.runCoordinator.respondToInput(
      conversationId,
      requestId,
      answers,
      identity,
    );
  }

  private commandFor(providerId: ProviderId): string {
    const resolved = this.resolvedCommands.get(providerId);
    if (resolved) return resolved;
    const configured = this.commands[providerId]?.trim();
    if (configured && !configured.includes("\0")) return configured;
    return PROVIDER_INFO[providerId].command;
  }

  private configuredInstallationBoundary(providerId: ProviderId): string {
    const configured = this.commands[providerId]?.trim();
    return configured && !configured.includes("\0")
      ? configured
      : PROVIDER_INFO[providerId].command;
  }
}
