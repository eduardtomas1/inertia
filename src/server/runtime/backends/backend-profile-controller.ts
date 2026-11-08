import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import {
  MAX_BACKEND_PROBE_MODELS,
  backendProfileUsesCredential,
  modelSelectionForBackendProfile,
  modelBackendProfileDraftSchema,
  modelBackendProfileUpdateSchema,
  persistedModelBackendProfileSchema,
  type BackendDiscoveredModel,
  type BackendProfileModelsResult,
  type ModelBackendDefault,
  type ModelBackendProfileCreateDraft,
  type ModelBackendProfileDetail,
  type ModelBackendProfileUpdate,
  type ModelBackendProfileView,
  type PersistedModelBackendProfile,
} from "../../../shared/backend-profile-settings";
import {
  backendPresetDefinition,
  isApiKeyBackendPresetId,
  normalizeBackendBaseUrl,
} from "../../../shared/backend-presets";
import {
  validateKimiClaudeModelSelection,
} from "../../../shared/claude-backend-profiles";
import {
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeResult,
} from "../../../shared/backend-probe";
import {
  BACKEND_CREDENTIAL_REQUIRED_MESSAGE,
  BACKEND_PROBE_AUTHORITY_SCHEMA_VERSION,
  claudeBackendRequiresCredential,
  BACKEND_PROBE_FRESHNESS_MS,
  BACKEND_PROBE_RENEWAL_MS,
  modelSelectionSchema,
  providerIdForHarness,
  providerNativeBackendProfile,
  providerNativeHarnessId,
  providerNativeModelSelection,
  routeSupportsNativeFastModeIdentity,
  type ModelSelection,
} from "../../../shared/model-routing";
import { backendEndpointIdentity } from "../../../shared/backend-endpoint-identity";
import type { ProviderInfo } from "../../../shared/contracts";
import {
  RecordNotFoundError,
  RuntimeStore,
  type StoredModelBackendProfile,
} from "../../database";
import type { ProviderManagerOptions } from "../../provider/contracts";
import { ProviderManager } from "../../providers";
import { probeBackendCompatibility } from "./backend-compatibility-probe";
import { PROVIDER_MAINTENANCE_RECOVERY_MESSAGE } from "../../../shared/provider-maintenance";
import { BackendProbeError, DEFAULT_TIMEOUT_MS, type HttpBackendProtocol } from "./backend-compatibility-probe/core";
import { discoverHttpBackendModels } from "./backend-compatibility-probe/discovery";
import { verifyBackendKey } from "./backend-key-check";

import {
  PROVIDER_IDS,
  backendProbeForModel,
  isUsableCompatibility,
  nativeProfile,
  normalizedBaseUrl,
  persistedKimiProfile,
  safeBackendProfile,
} from "./backend-profile-model";
import {
  backendProfileDraftFailure,
  backendProfileIssueFailure,
} from "./backend-profile-issues";
import {
  customConnectionValues,
  defaultProbeModelIds,
  presetConnectionValues,
  withPresetReasoning,
  type BackendConnectionValues,
} from "./backend-profile-presets";
import {
  backendConnectionSemantics,
  backendDraftForValidation,
  backendPersistedState,
  compatibilityFailureMessage, withPromptCacheTtl,
  profileProbesOverHttp,
  sameNormalizedBaseUrl,
} from "./backend-profile-rules";
import { BackendProfileRuntime, backendKeyVerified } from "./backend-profile-runtime";
import {
  BackendProfileControllerError,
  type BackendProfileControllerOptions,
} from "./backend-profile-types";

export {
  BackendProfileControllerError,
  type BackendCredentialBroker,
  type BackendProfileControllerOptions,
} from "./backend-profile-types";

const PROBE_BATCH_BUDGET_MS = 180_000;

const REMOVED_MODEL_MESSAGE =
  "The selected model is no longer configured on this backend profile. Start a new chat with another model.";

type ProbeAdmission = {
  operationId: string;
  admissionSequence: number;
  installationFingerprint: string | null;
};

export class BackendProfileController {
  private readonly store: RuntimeStore;
  private readonly runtime: BackendProfileRuntime;
  private readonly now: () => Date;
  private readonly probeOperationId: () => string;
  private readonly lifetimeSignal: AbortSignal | undefined;
  private readonly probeAdmissionSequences = new Map<string, number>();
  private readonly renewals = new Map<string, Promise<void>>();
  private changeListener: (() => void) | null = null;

  private constructor(options: BackendProfileControllerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.probeOperationId = options.probeOperationId ?? randomUUID;
    this.lifetimeSignal = options.signal;
    this.runtime = new BackendProfileRuntime(
      options.credentials,
      options.builtInClaudeProfiles ?? [],
      this.now,
    );
  }

  static async create(
    options: BackendProfileControllerOptions,
  ): Promise<BackendProfileController> {
    const controller = BackendProfileController.open(options);
    await controller.initialize();
    return controller;
  }

  static open(
    options: BackendProfileControllerOptions,
  ): BackendProfileController {
    return new BackendProfileController(options);
  }

  providerManagerOptions(): Pick<
    ProviderManagerOptions,
    | "backendProfiles"
    | "backendCompatibilities"
    | "backendProbeResults"
    | "backendProbeNow"
    | "resolveBackendLaunchOptions"
  > {
    return this.runtime.providerManagerOptions(
      this.store.listModelBackendProfiles(),
    );
  }

  attachProviderManager(providers: ProviderManager): void {
    this.runtime.attachProviderManager(providers);
  }

  attachProviderMutationGuard(
    providerMaintenanceBlocked: Parameters<
      BackendProfileRuntime["attachProviderMutationGuard"]
    >[0],
  ): void {
    this.runtime.attachProviderMutationGuard(providerMaintenanceBlocked);
  }

  attachChangeListener(listener: () => void): void {
    if (this.changeListener && this.changeListener !== listener) {
      throw new BackendProfileControllerError(
        "The backend profile change listener is already attached.",
      );
    }
    this.changeListener = listener;
  }

  profiles(providerInfo: readonly ProviderInfo[]): ModelBackendProfileView[] {
    this.runtime.rememberProviders(providerInfo);
    const native = PROVIDER_IDS.map((providerId) =>
      this.runtime.view(
        { profile: nativeProfile(
          providerId,
          providerInfo.find(({ id }) => id === providerId),
        ), probeResults: [], probeAdmissionHighWater: [], latestProbe: null },
      ));
    return [
      ...native,
      ...this.store.listModelBackendProfiles().map((record) =>
        this.runtime.view(record)),
    ];
  }

  defaults(): ModelBackendDefault[] {
    return this.store.listModelBackendDefaults();
  }

  detail(profileId: string): ModelBackendProfileDetail {
    const nativeProvider = PROVIDER_IDS.find((providerId) =>
      providerNativeBackendProfile(providerId).id === profileId);
    if (nativeProvider) {
      return this.runtime.detailView({
        profile: nativeProfile(
          nativeProvider,
          this.runtime.provider(nativeProvider),
        ),
        probeResults: [],
        probeAdmissionHighWater: [],
        latestProbe: null,
      });
    }
    return this.runtime.detailView(this.store.modelBackendProfile(profileId));
  }

  async createProfile(
    draftInput: ModelBackendProfileCreateDraft,
  ): Promise<ModelBackendProfileDetail> {
    const failure = backendProfileDraftFailure(draftInput);
    if (failure) throw new BackendProfileControllerError(failure);
    const draft = modelBackendProfileDraftSchema.parse(draftInput);
    const values: BackendConnectionValues = draft.preset === "custom"
      ? customConnectionValues(draft)
      : presetConnectionValues(draft);
    const baseUrl = this.connectionUrl(
      values.protocol,
      values.baseUrl,
      values.allowInsecureLocalhost,
    );
    const now = new Date().toISOString();
    const profile = this.parsePersisted({
      id: `custom:${randomUUID()}`,
      displayName: values.displayName,
      harnessId: values.harnessId,
      protocol: values.protocol,
      authenticationMode: values.authenticationMode,
      source: "custom",
      enabled: false,
      configurationRevision: 1,
      endpointIdentity: backendEndpointIdentity(baseUrl),
      preset: values.preset,
      baseUrl,
      allowInsecureLocalhost: values.allowInsecureLocalhost,
      allowPrivateNetwork: values.allowPrivateNetwork,
      credentialGeneration: null,
      models: this.withPresetReasoning(values.preset, values.models),
      routing: values.routing,
      capabilityHints: values.capabilityHints,
      ...(draft.promptCacheTtl ? { promptCacheTtl: draft.promptCacheTtl } : {}),
      createdAt: now,
      updatedAt: now,
    });
    this.runtime.assertConfigurationMutable(profile.harnessId);
    const stored = this.store.saveModelBackendProfile(profile);
    this.runtime.publishProfile(stored.profile);
    return this.runtime.detailView(stored);
  }

  async updateProfile(
    profileId: string,
    updateInput: unknown,
  ): Promise<ModelBackendProfileDetail> {
    return (await this.updateProfileWithOutcome(profileId, updateInput)).profile;
  }

  async updateProfileWithOutcome(
    profileId: string,
    updateInput: unknown,
  ): Promise<{ profile: ModelBackendProfileDetail; credentialCleared: boolean }> {
    const parsedUpdate = modelBackendProfileUpdateSchema.safeParse(updateInput);
    if (!parsedUpdate.success) {
      throw new BackendProfileControllerError(
        backendProfileIssueFailure(parsedUpdate.error.issues),
      );
    }
    const update = parsedUpdate.data;
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
    if (update.preset !== undefined && update.preset !== stored.profile.preset) {
      throw new BackendProfileControllerError(
        "The backend type cannot be changed. Add a new backend instead.",
      );
    }
    const { enabled: requestedEnabled, ...settings } = update;
    const requested = withPromptCacheTtl(stored.profile, settings);
    if (
      stored.profile.source === "custom"
      && Object.keys(settings).length > 0
    ) {
      const failure = backendProfileDraftFailure(backendDraftForValidation(requested, update));
      if (failure) throw new BackendProfileControllerError(failure);
    }
    const { baseUrl, endpointIdentity } = this.updatedEndpoint(stored.profile, requested, update);
    const merged = this.parsePersisted({
      ...requested,
      baseUrl,
      endpointIdentity,
      models: this.withPresetReasoning(requested.preset, requested.models),
      configurationRevision: stored.profile.configurationRevision,
      enabled: requestedEnabled ?? stored.profile.enabled,
      updatedAt: stored.profile.updatedAt,
    });
    const connectionChanged = backendConnectionSemantics(merged)
      !== backendConnectionSemantics(stored.profile);
    const credentialRebound = stored.profile.source === "custom" && (
      merged.endpointIdentity !== stored.profile.endpointIdentity
      || merged.protocol !== stored.profile.protocol
      || merged.authenticationMode !== stored.profile.authenticationMode
    );
    const candidate = this.parsePersisted({
      ...merged,
      configurationRevision: stored.profile.configurationRevision
        + (connectionChanged ? 1 : 0),
      enabled: connectionChanged ? false : merged.enabled,
      credentialGeneration: credentialRebound ? null : merged.credentialGeneration,
      updatedAt: new Date().toISOString(),
    });
    if (backendPersistedState(candidate) === backendPersistedState(stored.profile)) {
      return { profile: this.runtime.detailView(stored), credentialCleared: false };
    }
    if (candidate.enabled && !stored.profile.enabled) {
      const compatibility = this.runtime.compatibility(
        candidate,
        candidate.routing.primaryModelId,
        backendProbeForModel(stored, candidate.routing.primaryModelId),
      );
      const awaitingFirstProbe = compatibility.reasonCode === "probe-required"
        && backendKeyVerified(stored);
      if (!isUsableCompatibility(compatibility) && !awaitingFirstProbe) {
        throw new BackendProfileControllerError(
          `Test this backend before enabling it. ${compatibility.reason}`,
        );
      }
    }
    this.runtime.assertConfigurationMutable(candidate.harnessId);
    if (credentialRebound) {
      try {
        await this.runtime.removeCredential(profileId);
      } catch {
        throw new BackendProfileControllerError(
          "The saved key could not be removed, so the connection was not changed.",
        );
      }
      this.runtime.assertConfigurationMutable(candidate.harnessId);
    }
    const next = this.store.saveModelBackendProfile(candidate);
    this.runtime.publishProfile(next.profile);
    if (credentialRebound) await this.runtime.credentialStatus(profileId, true);
    return { profile: this.runtime.detailView(next), credentialCleared: credentialRebound };
  }

  async reconcileCredentialRevision(
    profileId: string,
    expectedGeneration: string,
  ): Promise<ModelBackendProfileDetail> {
    const status = await this.runtime.credentialStatus(profileId, true);
    if (!status || status.credentialGeneration !== expectedGeneration) {
      throw new BackendProfileControllerError(
        "The secure credential changed again before the runtime could reconcile it.",
      );
    }
    const current = this.store.modelBackendProfile(profileId);
    this.runtime.assertConfigurationMutable(current.profile.harnessId);
    const next = this.reconcileGeneration(current, status.credentialGeneration);
    return this.runtime.detailView(next);
  }

  async probe(
    profileId: string,
    modelIds?: readonly string[],
  ): Promise<ModelBackendProfileDetail> {
    return (await this.probeWithOutcome(profileId, modelIds)).profile;
  }

  async probeWithOutcome(
    profileId: string,
    modelIds?: readonly string[],
  ): Promise<{ profile: ModelBackendProfileDetail; skippedModelIds: string[] }> {
    let stored = this.store.modelBackendProfile(profileId);
    const profile = stored.profile;
    if (claudeBackendRequiresCredential(profile)) {
      throw new BackendProfileControllerError(BACKEND_CREDENTIAL_REQUIRED_MESSAGE);
    }
    if (modelIds !== undefined && modelIds.length === 0) {
      return { profile: await this.checkKey(stored), skippedModelIds: [] };
    }
    const requested = modelIds === undefined
      ? defaultProbeModelIds(profile)
      : [...new Set(modelIds)];
    if (requested.length > MAX_BACKEND_PROBE_MODELS) {
      throw new BackendProfileControllerError(
        `Test at most ${MAX_BACKEND_PROBE_MODELS} models at a time.`,
      );
    }
    if (
      requested.length === 0
      || requested.some((modelId) => !profile.models.some(({ id }) => id === modelId))
    ) {
      throw new BackendProfileControllerError(
        "The selected model is not configured on this backend.",
      );
    }
    stored = await this.requireCurrentCredential(stored, "testing the connection");
    const skippedModelIds: string[] = [];
    this.beginProbe(profileId);
    try {
      const startedAt = this.now().getTime();
      for (const modelId of requested) {
        if (
          skippedModelIds.length > 0
          || this.now().getTime() - startedAt + DEFAULT_TIMEOUT_MS > PROBE_BATCH_BUDGET_MS
        ) {
          skippedModelIds.push(modelId);
          continue;
        }
        await this.probeModel(profileId, modelId);
      }
    } finally {
      this.endProbe(profileId);
    }
    return {
      profile: this.runtime.detailView(this.store.modelBackendProfile(profileId)),
      skippedModelIds,
    };
  }

  private async requireCurrentCredential(
    record: StoredModelBackendProfile,
    action: string,
  ): Promise<StoredModelBackendProfile> {
    const profile = record.profile;
    if (!backendProfileUsesCredential(profile)) return record;
    const status = await this.runtime.credentialStatus(profile.id, true);
    let stored = record;
    if (status?.credentialGeneration !== profile.credentialGeneration) {
      this.runtime.assertConfigurationMutable(profile.harnessId);
      stored = this.reconcileGeneration(stored, status?.credentialGeneration ?? null);
    }
    if (!status?.hasSecret) {
      throw new BackendProfileControllerError(`Add the ${profile.displayName} credential before ${action}.`);
    }
    return stored;
  }

  private async checkKey(record: StoredModelBackendProfile): Promise<ModelBackendProfileDetail> {
    const stored = await this.requireCurrentCredential(record, "checking it");
    const { profile } = stored;
    const { baseUrl, protocol } = profile;
    if (baseUrl !== null && (protocol === "anthropic-messages" || protocol === "openai-responses")) {
      const endpoint = { ...profile, baseUrl, protocol };
      await verifyBackendKey({
        listModels: () => this.listModels(endpoint),
        primaryModelId: defaultProbeModelIds(profile)[0],
        probeModel: async (modelId) => backendProbeForModel(await this.probeModel(profile.id, modelId), modelId),
        now: this.now,
      });
    }
    this.runtime.assertConfigurationMutable(stored.profile.harnessId);
    const next = this.store.recordModelBackendKeyCheck(stored.profile.id, {
      credentialGeneration: stored.profile.credentialGeneration,
      checkedAt: this.now().toISOString(),
    });
    this.notifyChanged();
    return this.runtime.detailView(next);
  }

  async discoverModels(profileId: string): Promise<BackendProfileModelsResult> {
    const { profile } = this.store.modelBackendProfile(profileId);
    if (
      profile.baseUrl === null
      || (profile.protocol !== "anthropic-messages" && profile.protocol !== "openai-responses")
    ) {
      throw new BackendProfileControllerError(
        "Model lists can be loaded only for API key and custom backends.",
      );
    }
    if (backendProfileUsesCredential(profile)) {
      const status = await this.runtime.credentialStatus(profile.id, true);
      if (!status?.hasSecret) {
        throw new BackendProfileControllerError(
          `Add the ${profile.displayName} credential before loading its models.`,
        );
      }
    }
    try {
      const models = await this.listModels({ ...profile, baseUrl: profile.baseUrl, protocol: profile.protocol });
      return { kind: "backend.profile.models", profileId: profile.id, models };
    } catch (error) {
      if (error instanceof BackendProbeError) {
        throw new BackendProfileControllerError(error.message);
      }
      throw error;
    }
  }

  private listModels(
    profile: StoredModelBackendProfile["profile"] & { baseUrl: string; protocol: HttpBackendProtocol },
  ): Promise<BackendDiscoveredModel[]> {
    return discoverHttpBackendModels({
      protocol: profile.protocol,
      authenticationMode: profile.authenticationMode,
      endpointUrl: profile.baseUrl,
      secretReference: backendProfileUsesCredential(profile)
        ? this.runtime.secretReference(profile.id)
        : null,
      allowInsecureLocalhost: profile.allowInsecureLocalhost,
      allowPrivateNetwork: profile.allowPrivateNetwork,
    }, {
      resolveCredential: (reference, signal) =>
        this.runtime.resolveCredential(reference, signal),
    }, this.lifetimeSignal);
  }

  private async probeModel(
    profileId: string,
    modelId: string,
  ): Promise<StoredModelBackendProfile> {
    const stored = this.store.modelBackendProfile(profileId);
    const current = stored.profile;
    const model = current.models.find((candidate) => candidate.id === modelId);
    if (!model) return stored;
    const admission = this.nextProbeAdmission(stored, modelId);
    const probed = await probeBackendCompatibility({
      profile: safeBackendProfile(current),
      endpointUrl: current.baseUrl,
      modelId,
      secretReference: backendProfileUsesCredential(current)
        ? this.runtime.secretReference(current.id)
        : null,
      allowInsecureLocalhost: current.allowInsecureLocalhost,
      allowPrivateNetwork: current.allowPrivateNetwork,
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
        this.runtime.resolveCredential(reference, signal),
      now: this.now,
      admission,
    }, this.lifetimeSignal);
    const result = backendCompatibilityProbeResultSchema.parse({
      ...probed,
      authority: {
        schemaVersion: BACKEND_PROBE_AUTHORITY_SCHEMA_VERSION,
        operationId: admission.operationId,
        admissionSequence: admission.admissionSequence,
        installationFingerprint: admission.installationFingerprint,
        expiresAt: new Date(
          Date.parse(probed.checkedAt) + BACKEND_PROBE_FRESHNESS_MS,
        ).toISOString(),
      },
    });
    if (!this.probeAdmissionIsCurrent(current, modelId, admission.admissionSequence)) {
      return this.store.modelBackendProfile(profileId);
    }
    this.runtime.assertConfigurationMutable(current.harnessId);
    const next = this.store.recordModelBackendProbe(profileId, result);
    const persisted = backendProbeForModel(next, result.modelId);
    if (persisted) this.runtime.recordProbeResult(persisted);
    return next;
  }

  private nextProbeAdmission(
    stored: StoredModelBackendProfile,
    modelId: string,
  ): ProbeAdmission {
    const admissionSequence = this.advanceProbeAdmission(stored, modelId);
    return {
      operationId: this.probeOperationId(),
      admissionSequence,
      installationFingerprint: this.runtime.installationFingerprint(
        stored.profile.harnessId,
      ),
    };
  }

  private advanceProbeAdmission(
    stored: StoredModelBackendProfile,
    modelId: string,
  ): number {
    const key = this.probeAdmissionKey(stored.profile, modelId);
    const persisted = stored.probeAdmissionHighWater.find(
      (entry) => entry.modelId === modelId,
    )?.admissionSequence ?? 0;
    const current = Math.max(this.probeAdmissionSequences.get(key) ?? 0, persisted);
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new BackendProfileControllerError(
        "The backend probe admission sequence is exhausted.",
      );
    }
    const admissionSequence = current + 1;
    this.probeAdmissionSequences.set(key, admissionSequence);
    return admissionSequence;
  }

  private probeAdmissionIsCurrent(
    profile: StoredModelBackendProfile["profile"],
    modelId: string,
    admissionSequence: number,
  ): boolean {
    return this.probeAdmissionSequences.get(
      this.probeAdmissionKey(profile, modelId),
    ) === admissionSequence;
  }

  private probeAdmissionKey(
    profile: StoredModelBackendProfile["profile"],
    modelId: string,
  ): string {
    return `${profile.id}\0${profile.configurationRevision}\0${modelId}`;
  }

  setDefault(
    projectId: string | null,
    selectionInput: ModelSelection,
  ): ModelBackendDefault {
    const selection = this.validateSelection(selectionInput);
    this.runtime.assertConfigurationMutable(selection.harnessId);
    const record = this.recordForSelection(selection);
    const compatibility = this.runtime.compatibility(
      record.profile,
      selection.modelId,
      backendProbeForModel(record, selection.modelId),
    );
    if (!record.profile.enabled || !isUsableCompatibility(compatibility)) {
      throw new BackendProfileControllerError(
        "Only an enabled compatible backend can be a default.",
      );
    }
    return this.store.saveModelBackendDefault(projectId, selection);
  }

  clearDefault(projectId: string | null): void {
    const current = this.store.listModelBackendDefaults().find(
      (candidate) => candidate.projectId === projectId,
    );
    if (current) {
      this.runtime.assertConfigurationMutable(current.selection.harnessId);
    }
    this.store.clearModelBackendDefault(projectId);
  }

  replaceGlobalDefaultWithSettings(
    update: Parameters<RuntimeStore["updateSettingsClearingGlobalDefault"]>[0],
  ): void {
    const current = this.store.listModelBackendDefaults().find(
      (candidate) => candidate.projectId === null,
    );
    if (current) {
      this.runtime.assertConfigurationMutable(current.selection.harnessId);
    }
    this.store.updateSettingsClearingGlobalDefault(update);
  }

  async deleteProfile(profileId: string): Promise<void> {
    try {
      const existing = this.store.modelBackendProfile(profileId);
      this.runtime.assertConfigurationMutable(existing.profile.harnessId);
    } catch (error) {
      if (!(error instanceof RecordNotFoundError)) throw error;
    }
    try {
      this.store.deleteModelBackendProfile(profileId);
    } catch (error) {
      if (!(error instanceof RecordNotFoundError)) throw error;
      // A repeated delete retries vault tombstone cleanup after a prior crash.
    }
    this.runtime.removeProfile(profileId);
    await this.runtime.forgetCredential(profileId);
  }

  isExternalSelection(selection: ModelSelection): boolean {
    const providerId = providerIdForHarness(selection.harnessId);
    return providerId === null
      || selection.backendProfileId !== providerNativeBackendProfile(providerId).id;
  }

  supportsNativeFastModeControl(selectionInput: ModelSelection): boolean {
    const selection = modelSelectionSchema.parse(selectionInput);
    if (!routeSupportsNativeFastModeIdentity(selection)) return false;
    const providerId = selection.harnessId === "codex-app-server"
      ? "codex"
      : "claude";
    const provider = this.runtime.provider(providerId);
    const model = selection.modelId === "provider-default"
      ? provider?.models.find(({ isDefault }) => isDefault)
        ?? provider?.models[0]
      : provider?.models.find(({ id }) => id === selection.modelId);
    const expectedProviderValue = providerId === "codex"
      ? "priority"
      : "fast";
    return model?.fastMode?.providerValue === expectedProviderValue;
  }

  private validateReasoningEffort(
    modelLabel: string,
    reasoningOptions: readonly { value: string }[],
    submitted: string | null,
  ): string | null {
    if (submitted === null) return null;
    if (submitted.trim() !== submitted || submitted.length === 0) {
      throw new BackendProfileControllerError(
        "Choose a valid reasoning level or use the provider default.",
      );
    }
    if (reasoningOptions.length === 0) {
      throw new BackendProfileControllerError(
        `${modelLabel} does not expose reasoning choices.`,
      );
    }
    if (!reasoningOptions.some(({ value }) => value === submitted)) {
      throw new BackendProfileControllerError(
        `Reasoning level '${submitted}' is not supported by ${modelLabel}.`,
      );
    }
    return submitted;
  }

  private validateNativeProviderOptions(
    providerId: ProviderInfo["id"],
    model: ProviderInfo["models"][number] | undefined,
    selection: ModelSelection,
  ): void {
    const keys = Object.keys(selection.providerOptions);
    if (keys.length === 0) return;
    if (
      keys.length !== 1
      || keys[0] !== "fastMode"
      || typeof selection.providerOptions.fastMode !== "string"
    ) {
      throw new BackendProfileControllerError(
        "The native provider options are invalid.",
      );
    }
    if (providerId !== "codex" && providerId !== "claude") {
      throw new BackendProfileControllerError(
        "This provider does not expose a supported Fast mode.",
      );
    }
    const expectedProviderValue = providerId === "codex" ? "priority" : "fast";
    if (
      !model?.fastMode
      || model.fastMode.providerValue !== expectedProviderValue
      || selection.providerOptions.fastMode !== model.fastMode.providerValue
    ) {
      throw new BackendProfileControllerError(
        `${model?.label ?? selection.modelId} does not currently advertise Fast mode. Choose Standard or refresh provider models.`,
      );
    }
  }

  private rejectUnsupportedProviderOptions(selection: ModelSelection): void {
    if (Object.keys(selection.providerOptions).length === 0) return;
    throw new BackendProfileControllerError(
      "The selected model does not support provider options, including unverified Fast mode.",
    );
  }

  validateSelection(
    selectionInput: ModelSelection,
    options: { allowUnavailableNativeCatalog?: boolean } = {},
  ): ModelSelection {
    const submitted = modelSelectionSchema.parse(selectionInput);
    const nativeProvider = PROVIDER_IDS.find((providerId) =>
      providerNativeBackendProfile(providerId).id === submitted.backendProfileId);
    if (nativeProvider) {
      const backend = providerNativeBackendProfile(nativeProvider);
      const harnessId = providerNativeHarnessId(nativeProvider);
      if (
        submitted.harnessId !== harnessId
        || submitted.backendConfigurationRevision
          !== backend.configurationRevision
      ) {
        throw new BackendProfileControllerError(
          "The native model selection does not match its harness backend.",
        );
      }
      const provider = this.runtime.provider(nativeProvider);
      const catalog = provider?.models ?? [];
      const catalogFreshness = provider?.metadataState.models.freshness
        ?? "unavailable";
      const selectedModel = submitted.modelId === "provider-default"
        ? catalog.find(({ isDefault }) => isDefault) ?? catalog[0]
        : catalog.find(({ id }) => id === submitted.modelId);
      if (
        submitted.modelId !== "provider-default"
        && catalogFreshness !== "fresh"
        && !selectedModel
        && !options.allowUnavailableNativeCatalog
      ) {
        throw new BackendProfileControllerError(
          "Refresh provider models before using this exact route.",
        );
      }
      if (
        submitted.modelId !== "provider-default"
        && catalogFreshness === "fresh"
        && !selectedModel
      ) {
        throw new BackendProfileControllerError(
          "That model is no longer offered by the native harness.",
        );
      }
      this.validateNativeProviderOptions(
        nativeProvider,
        selectedModel,
        submitted,
      );
      const reasoningEffort = (
        options.allowUnavailableNativeCatalog
        && catalogFreshness !== "fresh"
        && !selectedModel
      )
        ? submitted.reasoningEffort
        : this.validateReasoningEffort(
            selectedModel?.label ?? (
              submitted.modelId === "provider-default"
                ? "Provider default"
                : submitted.modelId
            ),
            selectedModel?.reasoningOptions ?? [],
            submitted.reasoningEffort,
          );
      return providerNativeModelSelection({
        providerId: nativeProvider,
        modelId: submitted.modelId,
        alias: submitted.modelId === "provider-default"
          ? null
          : selectedModel && selectedModel.label !== selectedModel.id
            ? selectedModel.label
            : null,
        reasoningEffort,
        providerOptions: submitted.providerOptions,
      });
    }
    const record = this.recordForSelection(submitted);
    if (
      submitted.harnessId !== record.profile.harnessId
      || submitted.backendConfigurationRevision
        !== record.profile.configurationRevision
    ) {
      throw new BackendProfileControllerError(
        "The model selection does not match the current backend profile.",
      );
    }
    const model = record.profile.models.find(({ id }) =>
      id === submitted.modelId);
    if (!model) {
      throw new BackendProfileControllerError(REMOVED_MODEL_MESSAGE);
    }
    this.rejectUnsupportedProviderOptions(submitted);
    const reasoningEffort = this.validateReasoningEffort(
      model.displayName,
      model.reasoningOptions,
      submitted.reasoningEffort,
    );
    if (record.profile.preset === "kimi-code") {
      const full = this.runtime.claudeProfile(record.profile.id);
      if (!full) throw new BackendProfileControllerError("The Kimi backend is unavailable.");
      return validateKimiClaudeModelSelection(full, {
        ...submitted,
        backendProfileDisplayName: record.profile.displayName,
        alias: null,
        reasoningEffort,
        contextWindowOverride: model.contextWindowTokens,
        providerOptions: {},
        capabilities: model.capabilities,
      });
    }
    return modelSelectionForBackendProfile(
      record.profile,
      model.id,
      reasoningEffort,
    );
  }

  async readiness(
    selectionInput: ModelSelection,
    provider: ProviderInfo | undefined,
  ): Promise<{ ready: boolean; message: string | null } | null> {
    if (!this.isExternalSelection(selectionInput)) return null;
    let record = this.recordForSelection(selectionInput);
    if (claudeBackendRequiresCredential(record.profile)) {
      return { ready: false, message: BACKEND_CREDENTIAL_REQUIRED_MESSAGE };
    }
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
        message: provider?.installState === "recovery-required"
          ? provider.statusMessage ?? PROVIDER_MAINTENANCE_RECOVERY_MESSAGE
          : "The selected agent harness is not installed or could not be started.",
      };
    }
    if (provider.updateRequired) {
      return {
        ready: false,
        message: provider.statusMessage
          ?? `${provider.label} ${provider.updateRequired.installedVersion} is installed. Inertia needs ${provider.updateRequired.minimumVersion} or newer.`,
      };
    }
    if (backendProfileUsesCredential(record.profile)) {
      const status = await this.runtime.credentialStatus(
        record.profile.id,
        true,
      );
      if (status?.credentialGeneration !== record.profile.credentialGeneration) {
        this.runtime.assertConfigurationMutable(record.profile.harnessId);
        record = this.reconcileGeneration(record, status?.credentialGeneration ?? null);
      }
      if (!status?.hasSecret) {
        return {
          ready: false,
          message: `The ${record.profile.displayName} credential is unavailable.`,
        };
      }
    }
    if (profileProbesOverHttp(record.profile)) {
      return await this.readinessFromEvidence(record, selectionInput.modelId);
    }
    const compatibility = this.runtime.compatibility(
      record.profile,
      selectionInput.modelId,
      backendProbeForModel(record, selectionInput.modelId),
    );
    if (!isUsableCompatibility(compatibility)) {
      return { ready: false, message: compatibility.reason };
    }
    return { ready: true, message: null };
  }

  private async readinessFromEvidence(
    record: StoredModelBackendProfile,
    modelId: string,
  ): Promise<{ ready: boolean; message: string | null }> {
    if (!record.profile.models.some(({ id }) => id === modelId)) {
      return { ready: false, message: REMOVED_MODEL_MESSAGE };
    }
    const probe = backendProbeForModel(record, modelId);
    const compatibility = this.runtime.compatibility(record.profile, modelId, probe);
    const installationChanged = this.probeInstallationChanged(record.profile, probe);
    if (isUsableCompatibility(compatibility) && !installationChanged) {
      if (this.renewalDue(record, probe)) this.renewInBackground(record.profile.id, modelId);
      return { ready: true, message: null };
    }
    if (
      probe !== null
      && compatibility.reasonCode !== "probe-stale"
      && !installationChanged
      && !this.renewalDue(record, probe)
    ) {
      return { ready: false, message: compatibilityFailureMessage(compatibility, probe) };
    }
    let renewed: StoredModelBackendProfile;
    try {
      renewed = await this.renewNow(record.profile.id, modelId);
    } catch (error) {
      if (error instanceof BackendProfileControllerError) {
        return { ready: false, message: error.message };
      }
      throw error;
    }
    const renewedProbe = backendProbeForModel(renewed, modelId);
    const renewedCompatibility = this.runtime.compatibility(
      renewed.profile,
      modelId,
      renewedProbe,
    );
    return isUsableCompatibility(renewedCompatibility)
      ? { ready: true, message: null }
      : {
          ready: false,
          message: compatibilityFailureMessage(renewedCompatibility, renewedProbe),
        };
  }

  private probeInstallationChanged(
    profile: PersistedModelBackendProfile,
    probe: BackendCompatibilityProbeResult | null,
  ): boolean {
    const current = this.runtime.installationFingerprint(profile.harnessId);
    return probe !== null
      && current !== null
      && probe.authority?.installationFingerprint !== current;
  }

  private renewalDue(
    record: StoredModelBackendProfile,
    probe: BackendCompatibilityProbeResult | null,
  ): boolean {
    if (!probe) return true;
    const checkedAt = Date.parse(probe.checkedAt);
    if (!Number.isFinite(checkedAt)) return true;
    if (this.now().getTime() - checkedAt >= BACKEND_PROBE_RENEWAL_MS) return true;
    const requestedAt = Date.parse(record.probeRenewalRequestedAt ?? "");
    return Number.isFinite(requestedAt) && checkedAt <= requestedAt;
  }

  private renewInBackground(profileId: string, modelId: string): void {
    if (this.lifetimeSignal?.aborted) return;
    if (this.renewals.has(this.renewalKey(profileId, modelId))) return;
    void this.renewNow(profileId, modelId).catch(() => undefined);
  }

  private async renewNow(
    profileId: string,
    modelId: string,
  ): Promise<StoredModelBackendProfile> {
    const key = this.renewalKey(profileId, modelId);
    const existing = this.renewals.get(key);
    if (existing) {
      await existing;
      return this.store.modelBackendProfile(profileId);
    }
    const operation = (async () => {
      this.beginProbe(profileId, true);
      try {
        await this.probeModel(profileId, modelId);
      } finally {
        this.endProbe(profileId, true);
      }
    })();
    const settled = operation.then(() => undefined, () => undefined);
    this.renewals.set(key, settled);
    void settled.finally(() => {
      if (this.renewals.get(key) === settled) this.renewals.delete(key);
    });
    await operation;
    return this.store.modelBackendProfile(profileId);
  }

  private renewalKey(profileId: string, modelId: string): string {
    return `${profileId}\0${modelId}`;
  }

  private beginProbe(profileId: string, renewal = false): void {
    if (this.runtime.beginProbe(profileId, renewal)) this.notifyChanged();
  }

  private endProbe(profileId: string, renewal = false): void {
    if (this.runtime.endProbe(profileId, renewal)) this.notifyChanged();
  }

  private notifyChanged(): void {
    try {
      this.changeListener?.();
    } catch {
      return;
    }
  }

  private reconcileGeneration(
    record: StoredModelBackendProfile,
    credentialGeneration: string | null,
  ): StoredModelBackendProfile {
    const current = this.store.modelBackendProfile(record.profile.id);
    if (current.profile.credentialGeneration === credentialGeneration) return current;
    for (const model of current.profile.models) {
      this.advanceProbeAdmission(current, model.id);
    }
    const next = this.store.reconcileModelBackendCredentialGeneration(
      record.profile.id,
      credentialGeneration,
      this.now().toISOString(),
    );
    this.runtime.publishProfile(next.profile);
    return next;
  }

  private withPresetReasoning(
    preset: PersistedModelBackendProfile["preset"],
    models: PersistedModelBackendProfile["models"],
  ): PersistedModelBackendProfile["models"] {
    if (!isApiKeyBackendPresetId(preset)) return models;
    const providerId = backendPresetDefinition(preset).providerId;
    return withPresetReasoning(
      preset,
      models,
      this.runtime.provider(providerId)?.models ?? [],
    );
  }

  private connectionUrl(
    protocol: PersistedModelBackendProfile["protocol"],
    value: string,
    allowInsecureLocalhost: boolean,
  ): string {
    let normalized: string;
    try {
      normalized = normalizeBackendBaseUrl(protocol, value);
    } catch (error) {
      throw new BackendProfileControllerError(
        error instanceof Error ? error.message : "Enter a valid backend base URL.",
      );
    }
    return normalizedBaseUrl(normalized, allowInsecureLocalhost);
  }

  private updatedEndpoint(
    stored: PersistedModelBackendProfile,
    requested: PersistedModelBackendProfile,
    update: ModelBackendProfileUpdate,
  ): { baseUrl: string | null; endpointIdentity: string | null } {
    if (stored.source !== "custom") {
      return { baseUrl: stored.baseUrl, endpointIdentity: stored.endpointIdentity };
    }
    const candidate = update.baseUrl ?? stored.baseUrl;
    if (candidate === null) {
      return { baseUrl: stored.baseUrl, endpointIdentity: stored.endpointIdentity };
    }
    const normalized = this.connectionUrl(
      requested.protocol,
      candidate,
      requested.allowInsecureLocalhost,
    );
    if (
      stored.protocol === requested.protocol
      && (normalized === stored.baseUrl
        || sameNormalizedBaseUrl(stored.protocol, stored.baseUrl, normalized))
    ) {
      normalizedBaseUrl(stored.baseUrl!, requested.allowInsecureLocalhost);
      return { baseUrl: stored.baseUrl, endpointIdentity: stored.endpointIdentity };
    }
    return { baseUrl: normalized, endpointIdentity: backendEndpointIdentity(normalized) };
  }

  private parsePersisted(value: unknown): PersistedModelBackendProfile {
    try {
      return persistedModelBackendProfileSchema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BackendProfileControllerError(backendProfileIssueFailure(error.issues));
      }
      throw error;
    }
  }

  async initialize(recoveryBlockedProviders: ReadonlySet<ProviderInfo["id"]> = new Set()): Promise<void> {
    for (const builtIn of this.runtime.builtInProfiles()) {
      if (builtIn.preset !== "kimi-code") continue;
      const status = await this.runtime.credentialStatus(builtIn.id, true);
      // Credential status is read-only. Keep it truthful even while recovery
      // forbids changing the affected harness's profile or installation.
      if (recoveryBlockedProviders.has("claude")) continue;
      this.runtime.assertConfigurationMutable("claude-agent-sdk");
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
          this.now().toISOString(),
        ).profile;
      } else {
        profile = this.store.saveModelBackendProfile(profile).profile;
      }
      this.runtime.publishProfile(profile);
    }

    for (let stored of this.store.listModelBackendProfiles()) {
      const providerId = providerIdForHarness(stored.profile.harnessId);
      if (providerId && recoveryBlockedProviders.has(providerId)) {
        if (backendProfileUsesCredential(stored.profile)) {
          await this.runtime.credentialStatus(stored.profile.id, true);
        }
        continue;
      }
      this.runtime.assertConfigurationMutable(stored.profile.harnessId);
      if (backendProfileUsesCredential(stored.profile)) {
        const status = await this.runtime.credentialStatus(
          stored.profile.id,
          true,
        );
        if (
          stored.profile.credentialGeneration
            !== status?.credentialGeneration
        ) {
          stored = this.store.reconcileModelBackendCredentialGeneration(
            stored.profile.id,
            status?.credentialGeneration ?? null,
            this.now().toISOString(),
          );
        }
      }
      this.runtime.publishProfile(stored.profile);
    }
  }

  private recordForSelection(
    selection: Pick<ModelSelection, "backendProfileId">,
  ): StoredModelBackendProfile {
    const nativeProvider = PROVIDER_IDS.find((providerId) =>
      providerNativeBackendProfile(providerId).id === selection.backendProfileId);
    if (nativeProvider) {
      return {
        profile: nativeProfile(nativeProvider, undefined),
        probeResults: [],
        probeAdmissionHighWater: [],
        latestProbe: null,
      };
    }
    return this.store.modelBackendProfile(selection.backendProfileId);
  }

}
