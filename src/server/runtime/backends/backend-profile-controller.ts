import { createHash, randomUUID } from "node:crypto";

import {
  backendProfilePrimaryModel,
  backendProfileUsesCredential,
  modelBackendProfileDraftSchema,
  modelBackendProfileDetailSchema,
  modelBackendProfileUpdateSchema,
  modelBackendProfileViewSchema,
  persistedModelBackendProfileSchema,
  safeEndpointHost,
  type BackendModelDefinition,
  type ModelBackendDefault,
  type ModelBackendProfileDetail,
  type ModelBackendProfileDraft,
  type ModelBackendProfileView,
  type PersistedModelBackendProfile,
} from "../../../shared/backend-profile-settings";
import type { BackendCredentialStatus } from "../../../shared/backend-credentials";
import {
  KIMI_CLAUDE_REASONING_OPTIONS,
  KIMI_CODING_MODELS,
  claudeHarnessBackendCompatibility,
  claudeCompatibleBackendProfileSchema,
  createCustomClaudeBackendProfile,
  modelBackendProfileForClaudeProfile,
  validateKimiClaudeModelSelection,
  type ClaudeCompatibleBackendProfile,
  type ClaudeModelRouting,
} from "../../../shared/claude-backend-profiles";
import type { BackendCompatibilityProbeResult } from "../../../shared/backend-probe";
import {
  nativeBackendProfile,
  nativeHarnessId,
  modelBackendProfileSchema,
  modelSelectionSchema,
  resolveHarnessBackendCompatibility,
  type HarnessBackendCompatibility,
  type ModelBackendProfile,
  type ModelSelection,
} from "../../../shared/model-routing";
import type { ProviderId, ProviderInfo } from "../../../shared/contracts";
import { backendSecretReferenceForProfile } from "../../../node/backend-secret-reference";
import {
  RecordNotFoundError,
  RuntimeStore,
  type StoredModelBackendProfile,
} from "../../database";
import type {
  ProviderBackendLaunchOptions,
  ProviderManagerOptions,
  ProviderRunInput,
} from "../../provider/contracts";
import { ProviderManager } from "../../providers";
import { probeBackendCompatibility } from "./backend-compatibility-probe";
import {
  createClaudeBackendLaunchResolver,
} from "./claude-compatible-adapter";
import {
  createCodexResponsesBackendLaunchResolver,
  type CodexResponsesBackendProfile,
} from "./codex-responses-adapter";

const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const PROVIDER_IDS: readonly ProviderId[] = [
  "codex",
  "claude",
  "cursor",
  "opencode",
];

export interface BackendCredentialBroker {
  resolve(secretReference: string, signal?: AbortSignal): Promise<string | null>;
  status(secretReference: string, signal?: AbortSignal): Promise<BackendCredentialStatus>;
  forget(secretReference: string, signal?: AbortSignal): Promise<boolean>;
}

export interface BackendProfileControllerOptions {
  store: RuntimeStore;
  credentials?: BackendCredentialBroker;
  builtInClaudeProfiles?: readonly ClaudeCompatibleBackendProfile[];
}

export class BackendProfileControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendProfileControllerError";
  }
}

function normalizedBaseUrl(value: string, allowInsecureLocalhost: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BackendProfileControllerError("Enter a valid backend base URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const isLocalhost = hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1";
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol !== "https:"
      && !(allowInsecureLocalhost && isLocalhost && url.protocol === "http:"))
  ) {
    throw new BackendProfileControllerError(
      allowInsecureLocalhost
        ? "Backend URLs must use HTTPS, except explicit localhost HTTP."
        : "Backend URLs must use HTTPS and cannot contain credentials.",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

function endpointIdentity(baseUrl: string): string {
  return `endpoint:${createHash("sha256").update(baseUrl).digest("hex")}`;
}

function nativeModelDefinitions(provider: ProviderInfo | undefined): BackendModelDefinition[] {
  if (!provider || provider.models.length === 0) {
    return [{
      id: "provider-default",
      displayName: "Provider default",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    }];
  }
  return provider.models.map((model) => ({
    id: model.id,
    displayName: model.label,
    contextWindowTokens: null,
    reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    capabilities: [],
  }));
}

function nativeProfile(
  providerId: ProviderId,
  provider: ProviderInfo | undefined,
): PersistedModelBackendProfile {
  const profile = nativeBackendProfile(providerId);
  const models = nativeModelDefinitions(provider);
  return persistedModelBackendProfileSchema.parse({
    ...profile,
    harnessId: nativeHarnessId(providerId),
    preset: "native",
    baseUrl: null,
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models,
    routing: {
      mode: "simple",
      primaryModelId: models.find(({ id }) =>
        provider?.models.find((candidate) =>
          candidate.id === id && candidate.isDefault))?.id ?? models[0]!.id,
    },
    capabilityHints: [],
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
  });
}

function kimiModelDefinitions(
  profile: ClaudeCompatibleBackendProfile,
): BackendModelDefinition[] {
  return KIMI_CODING_MODELS.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    contextWindowTokens: profile.contextWindowTokens,
    reasoningOptions: KIMI_CLAUDE_REASONING_OPTIONS.map((option) => ({ ...option })),
    capabilities: profile.capabilityOverrides.map((capability) => ({ ...capability })),
  }));
}

function persistedKimiProfile(
  input: ClaudeCompatibleBackendProfile,
  credentialGeneration: string | null,
  existing?: StoredModelBackendProfile,
): PersistedModelBackendProfile {
  const profile = claudeCompatibleBackendProfileSchema.parse(input);
  if (profile.preset !== "kimi-code") {
    throw new BackendProfileControllerError("Only the built-in Kimi preset can be registered.");
  }
  const models = kimiModelDefinitions(profile);
  const now = new Date().toISOString();
  return persistedModelBackendProfileSchema.parse({
    ...modelBackendProfileForClaudeProfile(profile),
    enabled: existing?.profile.enabled ?? profile.enabled,
    configurationRevision:
      existing?.profile.configurationRevision ?? profile.configurationRevision,
    harnessId: "claude-agent-sdk",
    preset: "kimi-code",
    baseUrl: profile.baseUrl,
    allowInsecureLocalhost: false,
    credentialGeneration,
    models,
    routing: existing?.profile.routing ?? {
      mode: "simple",
      primaryModelId: profile.primaryModelId,
    },
    capabilityHints: profile.capabilityOverrides,
    createdAt: existing?.profile.createdAt ?? now,
    updatedAt: existing?.profile.updatedAt ?? now,
  });
}

function routingForClaude(
  profile: PersistedModelBackendProfile,
): ClaudeModelRouting {
  if (profile.routing.mode === "simple") return { mode: "simple" };
  return {
    mode: "advanced",
    tierModels: { ...profile.routing.tierModels },
    subagentModelId: profile.routing.subagentModelId,
  };
}

function isUsableCompatibility(compatibility: HarnessBackendCompatibility): boolean {
  return compatibility.state !== "unknown"
    && compatibility.state !== "unavailable";
}

function safeBackendProfile(
  profile: Pick<
    PersistedModelBackendProfile,
    | "id"
    | "displayName"
    | "protocol"
    | "authenticationMode"
    | "source"
    | "enabled"
    | "configurationRevision"
    | "endpointIdentity"
  >,
): ModelBackendProfile {
  return modelBackendProfileSchema.parse({
    id: profile.id,
    displayName: profile.displayName,
    protocol: profile.protocol,
    authenticationMode: profile.authenticationMode,
    source: profile.source,
    enabled: profile.enabled,
    configurationRevision: profile.configurationRevision,
    endpointIdentity: profile.endpointIdentity,
  });
}

function connectionState(
  result: BackendCompatibilityProbeResult | null,
): ModelBackendProfileView["connectionState"] {
  if (!result) return "not-tested";
  if (result.failure) return "failed";
  return result.compatibility === "protocol-compatible"
    ? "connected"
    : result.compatibility === "partially-compatible"
      ? "limited"
      : "failed";
}

export class BackendProfileController {
  private readonly store: RuntimeStore;
  private readonly credentials: BackendCredentialBroker | undefined;
  private readonly builtInClaudeProfiles = new Map<string, ClaudeCompatibleBackendProfile>();
  private readonly secretReferences = new Map<string, string>();
  private readonly claudeProfiles = new Map<string, ClaudeCompatibleBackendProfile>();
  private readonly codexProfiles = new Map<string, CodexResponsesBackendProfile>();
  private readonly credentialStatuses = new Map<string, BackendCredentialStatus | null>();
  private readonly providerInfo = new Map<ProviderId, ProviderInfo>();
  private providers: ProviderManager | null = null;
  private readonly resolveClaudeLaunch;
  private readonly resolveCodexLaunch;

  private constructor(options: BackendProfileControllerOptions) {
    this.store = options.store;
    this.credentials = options.credentials;
    for (const input of options.builtInClaudeProfiles ?? []) {
      const profile = claudeCompatibleBackendProfileSchema.parse(input);
      this.builtInClaudeProfiles.set(profile.id, profile);
      if (profile.secretReference) {
        this.secretReferences.set(profile.id, profile.secretReference);
      }
    }
    this.resolveClaudeLaunch = createClaudeBackendLaunchResolver({
      profiles: () => [...this.claudeProfiles.values()],
      resolveSecret: (reference, signal) =>
        this.credentials?.resolve(reference, signal) ?? Promise.resolve(null),
    });
    this.resolveCodexLaunch = createCodexResponsesBackendLaunchResolver({
      profiles: () => [...this.codexProfiles.values()],
      resolveSecret: (reference, signal) =>
        this.credentials?.resolve(reference, signal) ?? Promise.resolve(null),
    });
  }

  static async create(
    options: BackendProfileControllerOptions,
  ): Promise<BackendProfileController> {
    const controller = new BackendProfileController(options);
    await controller.initialize();
    return controller;
  }

  providerManagerOptions(): Pick<
    ProviderManagerOptions,
    | "backendProfiles"
    | "backendCompatibilities"
    | "backendProbeResults"
    | "resolveBackendLaunchOptions"
  > {
    const records = this.store.listModelBackendProfiles();
    return {
      backendProfiles: records.map(({ profile }) => safeBackendProfile(profile)),
      backendCompatibilities: records.flatMap(({ profile, latestProbe }) => {
        if (profile.source === "custom") return [];
        return [this.compatibility(
          profile,
          profile.routing.primaryModelId,
          latestProbe,
        )];
      }),
      backendProbeResults: records.flatMap(({ latestProbe }) =>
        latestProbe ? [latestProbe] : []),
      resolveBackendLaunchOptions: (input, environment, context) =>
        this.resolveLaunch(input, environment, context),
    };
  }

  attachProviderManager(providers: ProviderManager): void {
    if (this.providers && this.providers !== providers) {
      throw new BackendProfileControllerError(
        "The backend profile controller is already attached.",
      );
    }
    this.providers = providers;
  }

  profiles(providerInfo: readonly ProviderInfo[]): ModelBackendProfileView[] {
    for (const provider of providerInfo) this.providerInfo.set(provider.id, provider);
    const native = PROVIDER_IDS.map((providerId) =>
      this.view(
        { profile: nativeProfile(
          providerId,
          providerInfo.find(({ id }) => id === providerId),
        ), latestProbe: null },
      ));
    return [
      ...native,
      ...this.store.listModelBackendProfiles().map((record) => this.view(record)),
    ];
  }

  defaults(): ModelBackendDefault[] {
    return this.store.listModelBackendDefaults();
  }

  detail(profileId: string): ModelBackendProfileDetail {
    const nativeProvider = PROVIDER_IDS.find((providerId) =>
      nativeBackendProfile(providerId).id === profileId);
    if (nativeProvider) {
      return this.detailView({
        profile: nativeProfile(nativeProvider, this.providerInfo.get(nativeProvider)),
        latestProbe: null,
      });
    }
    return this.detailView(this.store.modelBackendProfile(profileId));
  }

  async createProfile(
    draftInput: ModelBackendProfileDraft,
  ): Promise<ModelBackendProfileDetail> {
    const draft = modelBackendProfileDraftSchema.parse(draftInput);
    if (draft.preset !== "custom") {
      throw new BackendProfileControllerError(
        "Kimi is available as a single verified built-in preset.",
      );
    }
    const baseUrl = normalizedBaseUrl(
      draft.baseUrl,
      draft.allowInsecureLocalhost,
    );
    const now = new Date().toISOString();
    const profile = persistedModelBackendProfileSchema.parse({
      id: `custom:${randomUUID()}`,
      displayName: draft.displayName,
      harnessId: draft.harnessId,
      protocol: draft.protocol,
      authenticationMode: draft.authenticationMode,
      source: "custom",
      enabled: false,
      configurationRevision: 1,
      endpointIdentity: endpointIdentity(baseUrl),
      preset: "custom",
      baseUrl,
      allowInsecureLocalhost: draft.allowInsecureLocalhost,
      credentialGeneration: null,
      models: draft.models,
      routing: draft.routing,
      capabilityHints: draft.capabilityHints,
      createdAt: now,
      updatedAt: now,
    });
    const stored = this.store.saveModelBackendProfile(profile);
    this.registerPrivilegedProfile(stored.profile);
    this.providers?.upsertBackendProfile(safeBackendProfile(stored.profile));
    return this.detailView(stored);
  }

  async updateProfile(
    profileId: string,
    updateInput: unknown,
  ): Promise<ModelBackendProfileDetail> {
    const update = modelBackendProfileUpdateSchema.parse(updateInput);
    const stored = this.store.modelBackendProfile(profileId);
    if (stored.profile.preset === "native") {
      throw new BackendProfileControllerError(
        "Native backends are configured by their harness.",
      );
    }
    if (stored.profile.source === "built-in") {
      const disallowed = Object.keys(update).some((key) =>
        !["enabled", "models", "routing", "capabilityHints"].includes(key));
      if (disallowed) {
        throw new BackendProfileControllerError(
          "Built-in backend connection settings cannot be replaced.",
        );
      }
    }
    const now = new Date().toISOString();
    const baseUrl = update.baseUrl === undefined
      ? stored.profile.baseUrl
      : normalizedBaseUrl(
          update.baseUrl,
          update.allowInsecureLocalhost
            ?? stored.profile.allowInsecureLocalhost,
        );
    const executionChanged = [
      "harnessId",
      "protocol",
      "authenticationMode",
      "baseUrl",
      "allowInsecureLocalhost",
      "models",
      "routing",
      "capabilityHints",
    ].some((key) => Object.hasOwn(update, key));
    const candidate = persistedModelBackendProfileSchema.parse({
      ...stored.profile,
      ...update,
      baseUrl,
      endpointIdentity: baseUrl === stored.profile.baseUrl
        ? stored.profile.endpointIdentity
        : endpointIdentity(baseUrl!),
      configurationRevision: stored.profile.configurationRevision
        + (executionChanged ? 1 : 0),
      enabled: executionChanged
        ? false
        : update.enabled ?? stored.profile.enabled,
      updatedAt: now,
    });
    if (candidate.enabled && !stored.profile.enabled) {
      const compatibility = this.compatibility(
        candidate,
        candidate.routing.primaryModelId,
        stored.latestProbe,
      );
      if (!isUsableCompatibility(compatibility)) {
        throw new BackendProfileControllerError(
          `Test this backend before enabling it. ${compatibility.reason}`,
        );
      }
    }
    const next = this.store.saveModelBackendProfile(candidate);
    this.registerPrivilegedProfile(next.profile);
    this.providers?.upsertBackendProfile(safeBackendProfile(next.profile));
    return this.detailView(next);
  }

  async reconcileCredentialRevision(
    profileId: string,
    expectedGeneration: string,
  ): Promise<ModelBackendProfileDetail> {
    const status = await this.credentialStatus(profileId, true);
    if (!status || status.credentialGeneration !== expectedGeneration) {
      throw new BackendProfileControllerError(
        "The secure credential changed again before the runtime could reconcile it.",
      );
    }
    const next = this.store.reconcileModelBackendCredentialGeneration(
      profileId,
      status.credentialGeneration,
    );
    this.registerPrivilegedProfile(next.profile);
    this.providers?.upsertBackendProfile(safeBackendProfile(next.profile));
    this.providers?.removeBackendProbeResults(profileId);
    return this.detailView(next);
  }

  async probe(
    profileId: string,
    modelId: string,
  ): Promise<ModelBackendProfileDetail> {
    let stored = this.store.modelBackendProfile(profileId);
    const profile = stored.profile;
    if (!profile.models.some((model) => model.id === modelId)) {
      throw new BackendProfileControllerError(
        "The selected model is not configured on this backend.",
      );
    }
    if (backendProfileUsesCredential(profile)) {
      const status = await this.credentialStatus(profile.id, true);
      if (status?.credentialGeneration !== profile.credentialGeneration) {
        stored = this.store.reconcileModelBackendCredentialGeneration(
          profile.id,
          status?.credentialGeneration ?? null,
        );
        this.registerPrivilegedProfile(stored.profile);
        this.providers?.upsertBackendProfile(safeBackendProfile(stored.profile));
      }
      if (!status?.hasSecret) {
        throw new BackendProfileControllerError(
          `Add the ${profile.displayName} credential before testing the connection.`,
        );
      }
    }
    const current = stored.profile;
    const model = current.models.find((candidate) => candidate.id === modelId)!;
    const result = await probeBackendCompatibility({
      profile: safeBackendProfile(current),
      endpointUrl: current.baseUrl,
      modelId,
      secretReference: backendProfileUsesCredential(current)
        ? this.secretReference(current.id)
        : null,
      allowInsecureLocalhost: current.allowInsecureLocalhost,
      capabilityHints: current.capabilityHints,
      contextWindowHint: model.contextWindowTokens === null
        ? null
        : {
            tokens: model.contextWindowTokens,
            provenance: "user",
            detail: "Configured on this backend profile.",
          },
    }, {
      resolveCredential: (reference, signal) =>
        this.credentials?.resolve(reference, signal) ?? Promise.resolve(null),
    });
    const next = this.store.recordModelBackendProbe(profileId, result);
    this.providers?.recordBackendProbeResult(result);
    return this.detailView(next);
  }

  setDefault(
    projectId: string | null,
    selectionInput: ModelSelection,
  ): ModelBackendDefault {
    const selection = this.validateSelection(selectionInput);
    const record = this.recordForSelection(selection);
    const compatibility = this.compatibility(
      record.profile,
      selection.modelId,
      record.latestProbe,
    );
    if (!record.profile.enabled || !isUsableCompatibility(compatibility)) {
      throw new BackendProfileControllerError(
        "Only an enabled compatible backend can be a default.",
      );
    }
    return this.store.saveModelBackendDefault(projectId, selection);
  }

  clearDefault(projectId: string | null): void {
    this.store.clearModelBackendDefault(projectId);
  }

  async deleteProfile(profileId: string): Promise<void> {
    const reference = this.secretReference(profileId);
    try {
      this.store.deleteModelBackendProfile(profileId);
    } catch (error) {
      if (!(error instanceof RecordNotFoundError)) throw error;
      // A repeated delete retries vault tombstone cleanup after a prior crash.
    }
    this.claudeProfiles.delete(profileId);
    this.codexProfiles.delete(profileId);
    this.providers?.removeBackendProfile(profileId);
    this.credentialStatuses.delete(profileId);
    await this.credentials?.forget(reference).catch(() => false);
  }

  isExternalSelection(selection: ModelSelection): boolean {
    return selection.backendProfileId !== "builtin:openai"
      && selection.backendProfileId !== "builtin:anthropic"
      && selection.backendProfileId !== "builtin:cursor"
      && selection.backendProfileId !== "builtin:opencode";
  }

  validateSelection(selectionInput: ModelSelection): ModelSelection {
    const nativeProvider = PROVIDER_IDS.find((providerId) =>
      nativeBackendProfile(providerId).id === selectionInput.backendProfileId);
    if (nativeProvider) {
      const backend = nativeBackendProfile(nativeProvider);
      const harnessId = nativeHarnessId(nativeProvider);
      if (
        selectionInput.harnessId !== harnessId
        || selectionInput.backendConfigurationRevision
          !== backend.configurationRevision
      ) {
        throw new BackendProfileControllerError(
          "The native model selection does not match its harness backend.",
        );
      }
      const catalog = this.providerInfo.get(nativeProvider)?.models ?? [];
      if (
        catalog.length > 0
        && selectionInput.modelId !== "provider-default"
        && !catalog.some(({ id }) => id === selectionInput.modelId)
      ) {
        throw new BackendProfileControllerError(
          "That model is no longer offered by the native harness.",
        );
      }
      return modelSelectionSchema.parse({
        ...selectionInput,
        harnessId,
        backendProfileId: backend.id,
        backendProfileDisplayName: backend.displayName,
        backendConfigurationRevision: backend.configurationRevision,
      });
    }
    const record = this.recordForSelection(selectionInput);
    const selection = modelSelectionSchema.parse(selectionInput);
    if (
      selection.harnessId !== record.profile.harnessId
      || selection.backendProfileDisplayName !== record.profile.displayName
      || selection.backendConfigurationRevision
        !== record.profile.configurationRevision
      || !record.profile.models.some(({ id }) => id === selection.modelId)
    ) {
      throw new BackendProfileControllerError(
        "The model selection does not match the current backend profile.",
      );
    }
    if (record.profile.preset === "kimi-code") {
      const full = this.claudeProfiles.get(record.profile.id);
      if (!full) throw new BackendProfileControllerError("The Kimi backend is unavailable.");
      return validateKimiClaudeModelSelection(full, selection);
    }
    return selection;
  }

  async readiness(
    selectionInput: ModelSelection,
    provider: ProviderInfo | undefined,
  ): Promise<{ ready: boolean; message: string | null } | null> {
    if (!this.isExternalSelection(selectionInput)) return null;
    let record = this.recordForSelection(selectionInput);
    if (!record.profile.enabled) {
      return {
        ready: false,
        message: `Model backend '${record.profile.displayName}' is disabled.`,
      };
    }
    if (
      !provider
      || provider.installState !== "installed"
      || !provider.available
      || !provider.executable
    ) {
      return {
        ready: false,
        message: "The selected agent harness is not installed or could not be started.",
      };
    }
    if (backendProfileUsesCredential(record.profile)) {
      const status = await this.credentialStatus(record.profile.id, true);
      if (status?.credentialGeneration !== record.profile.credentialGeneration) {
        record = this.store.reconcileModelBackendCredentialGeneration(
          record.profile.id,
          status?.credentialGeneration ?? null,
        );
        this.registerPrivilegedProfile(record.profile);
        this.providers?.upsertBackendProfile(safeBackendProfile(record.profile));
        return {
          ready: false,
          message: "The backend credential changed. Test and enable this profile again.",
        };
      }
      if (!status?.hasSecret) {
        return {
          ready: false,
          message: `The ${record.profile.displayName} credential is unavailable.`,
        };
      }
    }
    const compatibility = this.compatibility(
      record.profile,
      selectionInput.modelId,
      record.latestProbe,
    );
    if (!isUsableCompatibility(compatibility)) {
      return { ready: false, message: compatibility.reason };
    }
    return { ready: true, message: null };
  }

  private async initialize(): Promise<void> {
    for (const builtIn of this.builtInClaudeProfiles.values()) {
      if (builtIn.preset !== "kimi-code") continue;
      const status = await this.credentialStatus(builtIn.id, true);
      let existing: StoredModelBackendProfile | undefined;
      try {
        existing = this.store.modelBackendProfile(builtIn.id);
      } catch (error) {
        if (!(error instanceof RecordNotFoundError)) throw error;
      }
      let profile = persistedKimiProfile(
        builtIn,
        status?.credentialGeneration ?? null,
        existing,
      );
      if (
        existing
        && existing.profile.credentialGeneration !== status?.credentialGeneration
      ) {
        profile = this.store.reconcileModelBackendCredentialGeneration(
          existing.profile.id,
          status?.credentialGeneration ?? null,
        ).profile;
      } else {
        profile = this.store.saveModelBackendProfile(profile).profile;
      }
      this.registerPrivilegedProfile(profile);
    }

    for (let stored of this.store.listModelBackendProfiles()) {
      if (backendProfileUsesCredential(stored.profile)) {
        const status = await this.credentialStatus(stored.profile.id, true);
        if (
          stored.profile.credentialGeneration
            !== status?.credentialGeneration
        ) {
          stored = this.store.reconcileModelBackendCredentialGeneration(
            stored.profile.id,
            status?.credentialGeneration ?? null,
          );
        }
      }
      this.registerPrivilegedProfile(stored.profile);
    }
  }

  private recordForSelection(
    selection: Pick<ModelSelection, "backendProfileId">,
  ): StoredModelBackendProfile {
    const nativeProvider = PROVIDER_IDS.find((providerId) =>
      nativeBackendProfile(providerId).id === selection.backendProfileId);
    if (nativeProvider) {
      return {
        profile: nativeProfile(nativeProvider, undefined),
        latestProbe: null,
      };
    }
    return this.store.modelBackendProfile(selection.backendProfileId);
  }

  private registerPrivilegedProfile(
    profile: PersistedModelBackendProfile,
  ): void {
    if (profile.protocol === "anthropic-messages") {
      const secretReference = backendProfileUsesCredential(profile)
        ? this.secretReference(profile.id)
        : null;
      const builtIn = this.builtInClaudeProfiles.get(profile.id);
      let full: ClaudeCompatibleBackendProfile;
      if (builtIn) {
        full = claudeCompatibleBackendProfileSchema.parse({
          ...builtIn,
          displayName: profile.displayName,
          authenticationMode: profile.authenticationMode,
          source: profile.source,
          enabled: profile.enabled,
          configurationRevision: profile.configurationRevision,
          endpointIdentity: profile.endpointIdentity,
          baseUrl: profile.baseUrl,
          secretReference,
          primaryModelId: profile.routing.primaryModelId,
          routing: routingForClaude(profile),
          capabilityOverrides: profile.capabilityHints,
        });
      } else {
        const created = createCustomClaudeBackendProfile({
          id: profile.id,
          displayName: profile.displayName,
          baseUrl: profile.baseUrl!,
          authenticationMode: profile.authenticationMode === "harness-managed"
            ? "none"
            : profile.authenticationMode,
          secretReference,
          primaryModelId: profile.routing.primaryModelId,
          configurationRevision: profile.configurationRevision,
          enabled: profile.enabled,
          allowInsecureLocalhost: profile.allowInsecureLocalhost,
          routing: routingForClaude(profile),
          contextWindowTokens:
            backendProfilePrimaryModel(profile).contextWindowTokens,
          capabilityOverrides: profile.capabilityHints,
        });
        full = claudeCompatibleBackendProfileSchema.parse({
          ...created,
          endpointIdentity: profile.endpointIdentity,
        });
      }
      this.claudeProfiles.set(profile.id, full);
      this.codexProfiles.delete(profile.id);
      return;
    }
    if (profile.protocol === "openai-responses") {
      this.codexProfiles.set(profile.id, {
        profile: safeBackendProfile(profile),
        baseUrl: profile.baseUrl!,
        secretReference: backendProfileUsesCredential(profile)
          ? this.secretReference(profile.id)
          : null,
      });
      this.claudeProfiles.delete(profile.id);
    }
  }

  private async credentialStatus(
    profileId: string,
    refresh = false,
  ): Promise<BackendCredentialStatus | null> {
    if (!refresh && this.credentialStatuses.has(profileId)) {
      return this.credentialStatuses.get(profileId) ?? null;
    }
    if (!this.credentials) {
      this.credentialStatuses.set(profileId, null);
      return null;
    }
    try {
      const status = await this.credentials.status(
        this.secretReference(profileId),
      );
      this.credentialStatuses.set(profileId, status);
      return status;
    } catch {
      this.credentialStatuses.set(profileId, null);
      return null;
    }
  }

  private view(record: StoredModelBackendProfile): ModelBackendProfileView {
    const profile = record.profile;
    const { baseUrl: _baseUrl, ...profileWithoutBaseUrl } = profile;
    const status = this.credentialStatuses.get(profile.id);
    const compatibility = this.compatibility(
      profile,
      profile.routing.primaryModelId,
      record.latestProbe,
    );
    const authState = profile.authenticationMode === "harness-managed"
      ? "harness-managed"
      : !backendProfileUsesCredential(profile)
        ? "not-required"
        : status === undefined
          ? "checking"
          : status === null
            ? "unavailable"
            : status.hasSecret
              && status.credentialGeneration === profile.credentialGeneration
              ? "configured"
              : "missing";
    return modelBackendProfileViewSchema.parse({
      ...profileWithoutBaseUrl,
      endpointHost: safeEndpointHost(profile.baseUrl),
      authState,
      connectionState: profile.preset === "native"
        ? "connected"
        : connectionState(record.latestProbe),
      compatibility,
      latestProbe: record.latestProbe,
      canDelete: profile.source === "custom",
      canDisable: profile.preset !== "native",
    });
  }

  private detailView(
    record: StoredModelBackendProfile,
  ): ModelBackendProfileDetail {
    return modelBackendProfileDetailSchema.parse({
      ...this.view(record),
      baseUrl: record.profile.baseUrl,
    });
  }

  private secretReference(profileId: string): string {
    return this.secretReferences.get(profileId)
      ?? backendSecretReferenceForProfile(profileId);
  }

  private compatibility(
    profile: PersistedModelBackendProfile,
    modelId: string,
    probe: BackendCompatibilityProbeResult | null,
  ): HarnessBackendCompatibility {
    if (profile.preset === "kimi-code") {
      const full = this.claudeProfiles.get(profile.id);
      if (full) {
        return claudeHarnessBackendCompatibility(
          full,
          profile.harnessId as "claude-agent-sdk" | "claude-cli",
          { modelId, probe },
        );
      }
    }
    return resolveHarnessBackendCompatibility(
      profile.harnessId,
      safeBackendProfile(profile),
      { modelId, probe },
    );
  }

  private resolveLaunch(
    input: ProviderRunInput,
    environment: NodeJS.ProcessEnv,
    context: Parameters<NonNullable<
      ProviderManagerOptions["resolveBackendLaunchOptions"]
    >>[2],
  ): ProviderBackendLaunchOptions | Promise<ProviderBackendLaunchOptions> {
    if (
      input.harnessId === "claude-agent-sdk"
      || input.harnessId === "claude-cli"
    ) {
      return this.resolveClaudeLaunch(input, environment, context);
    }
    if (
      input.harnessId === "codex-app-server"
      || input.harnessId === "codex-cli"
    ) {
      return this.resolveCodexLaunch(input, environment, context);
    }
    return { environment: { ...environment } };
  }
}
