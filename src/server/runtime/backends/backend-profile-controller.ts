import { randomUUID } from "node:crypto";

import {
  backendProfileUsesCredential,
  modelSelectionForBackendProfile,
  modelBackendProfileDraftSchema,
  modelBackendProfileUpdateSchema,
  persistedModelBackendProfileSchema,
  type ModelBackendDefault,
  type ModelBackendProfileDetail,
  type ModelBackendProfileDraft,
  type ModelBackendProfileView,
} from "../../../shared/backend-profile-settings";
import {
  validateKimiClaudeModelSelection,
} from "../../../shared/claude-backend-profiles";
import {
  nativeBackendProfile,
  nativeHarnessId,
  nativeModelSelection,
  modelSelectionSchema,
  type ModelSelection,
} from "../../../shared/model-routing";
import type { ProviderInfo } from "../../../shared/contracts";
import {
  RecordNotFoundError,
  RuntimeStore,
  type StoredModelBackendProfile,
} from "../../database";
import type { ProviderManagerOptions } from "../../provider/contracts";
import { ProviderManager } from "../../providers";
import { probeBackendCompatibility } from "./backend-compatibility-probe";

import {
  PROVIDER_IDS,
  endpointIdentity,
  isUsableCompatibility,
  nativeProfile,
  normalizedBaseUrl,
  persistedKimiProfile,
  safeBackendProfile,
} from "./backend-profile-model";
import { BackendProfileRuntime } from "./backend-profile-runtime";
import {
  BackendProfileControllerError,
  type BackendProfileControllerOptions,
} from "./backend-profile-types";

export {
  BackendProfileControllerError,
  type BackendCredentialBroker,
  type BackendProfileControllerOptions,
} from "./backend-profile-types";

function backendExecutionSemantics(
  profile: StoredModelBackendProfile["profile"],
): string {
  return JSON.stringify({
    harnessId: profile.harnessId,
    protocol: profile.protocol,
    authenticationMode: profile.authenticationMode,
    preset: profile.preset,
    baseUrl: profile.baseUrl,
    allowInsecureLocalhost: profile.allowInsecureLocalhost,
    models: profile.models,
    routing: profile.routing,
    capabilityHints: profile.capabilityHints,
  });
}

function backendPersistedState(
  profile: StoredModelBackendProfile["profile"],
): string {
  return JSON.stringify({
    ...profile,
    updatedAt: null,
  });
}

export class BackendProfileController {
  private readonly store: RuntimeStore;
  private readonly runtime: BackendProfileRuntime;

  private constructor(options: BackendProfileControllerOptions) {
    this.store = options.store;
    this.runtime = new BackendProfileRuntime(
      options.credentials,
      options.builtInClaudeProfiles ?? [],
    );
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
    return this.runtime.providerManagerOptions(
      this.store.listModelBackendProfiles(),
    );
  }

  attachProviderManager(providers: ProviderManager): void {
    this.runtime.attachProviderManager(providers);
  }

  profiles(providerInfo: readonly ProviderInfo[]): ModelBackendProfileView[] {
    this.runtime.rememberProviders(providerInfo);
    const native = PROVIDER_IDS.map((providerId) =>
      this.runtime.view(
        { profile: nativeProfile(
          providerId,
          providerInfo.find(({ id }) => id === providerId),
        ), latestProbe: null },
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
      nativeBackendProfile(providerId).id === profileId);
    if (nativeProvider) {
      return this.runtime.detailView({
        profile: nativeProfile(
          nativeProvider,
          this.runtime.provider(nativeProvider),
        ),
        latestProbe: null,
      });
    }
    return this.runtime.detailView(this.store.modelBackendProfile(profileId));
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
    this.runtime.publishProfile(stored.profile);
    return this.runtime.detailView(stored);
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
    const merged = persistedModelBackendProfileSchema.parse({
      ...stored.profile,
      ...update,
      baseUrl,
      endpointIdentity: baseUrl === stored.profile.baseUrl
        ? stored.profile.endpointIdentity
        : endpointIdentity(baseUrl!),
      configurationRevision: stored.profile.configurationRevision,
      enabled: update.enabled ?? stored.profile.enabled,
      updatedAt: stored.profile.updatedAt,
    });
    const executionChanged = backendExecutionSemantics(merged)
      !== backendExecutionSemantics(stored.profile);
    const candidate = persistedModelBackendProfileSchema.parse({
      ...merged,
      configurationRevision: stored.profile.configurationRevision
        + (executionChanged ? 1 : 0),
      enabled: executionChanged ? false : merged.enabled,
      updatedAt: now,
    });
    if (backendPersistedState(candidate) === backendPersistedState(stored.profile)) {
      return this.runtime.detailView(stored);
    }
    if (candidate.enabled && !stored.profile.enabled) {
      const compatibility = this.runtime.compatibility(
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
    this.runtime.publishProfile(next.profile);
    return this.runtime.detailView(next);
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
    const next = this.store.reconcileModelBackendCredentialGeneration(
      profileId,
      status.credentialGeneration,
    );
    this.runtime.publishProfile(next.profile);
    this.runtime.removeProbeResults(profileId);
    return this.runtime.detailView(next);
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
      const status = await this.runtime.credentialStatus(profile.id, true);
      if (status?.credentialGeneration !== profile.credentialGeneration) {
        stored = this.store.reconcileModelBackendCredentialGeneration(
          profile.id,
          status?.credentialGeneration ?? null,
        );
        this.runtime.publishProfile(stored.profile);
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
        ? this.runtime.secretReference(current.id)
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
        this.runtime.resolveCredential(reference, signal),
    });
    const next = this.store.recordModelBackendProbe(profileId, result);
    this.runtime.recordProbeResult(result);
    return this.runtime.detailView(next);
  }

  setDefault(
    projectId: string | null,
    selectionInput: ModelSelection,
  ): ModelBackendDefault {
    const selection = this.validateSelection(selectionInput);
    const record = this.recordForSelection(selection);
    const compatibility = this.runtime.compatibility(
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
    return selection.backendProfileId !== "builtin:openai"
      && selection.backendProfileId !== "builtin:anthropic"
      && selection.backendProfileId !== "builtin:cursor"
      && selection.backendProfileId !== "builtin:opencode";
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

  private rejectUnsupportedProviderOptions(
    selection: ModelSelection,
  ): void {
    if (Object.keys(selection.providerOptions).length === 0) return;
    throw new BackendProfileControllerError(
      "The selected model does not support provider options.",
    );
  }

  validateSelection(
    selectionInput: ModelSelection,
    options: { allowUnavailableNativeCatalog?: boolean } = {},
  ): ModelSelection {
    const submitted = modelSelectionSchema.parse(selectionInput);
    const nativeProvider = PROVIDER_IDS.find((providerId) =>
      nativeBackendProfile(providerId).id === submitted.backendProfileId);
    if (nativeProvider) {
      const backend = nativeBackendProfile(nativeProvider);
      const harnessId = nativeHarnessId(nativeProvider);
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
      this.rejectUnsupportedProviderOptions(submitted);
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
      return nativeModelSelection({
        providerId: nativeProvider,
        modelId: submitted.modelId,
        alias: submitted.modelId === "provider-default"
          ? null
          : selectedModel && selectedModel.label !== selectedModel.id
            ? selectedModel.label
            : null,
        reasoningEffort,
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
      throw new BackendProfileControllerError(
        "The selected model is no longer configured on this backend profile.",
      );
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
      const status = await this.runtime.credentialStatus(
        record.profile.id,
        true,
      );
      if (status?.credentialGeneration !== record.profile.credentialGeneration) {
        record = this.store.reconcileModelBackendCredentialGeneration(
          record.profile.id,
          status?.credentialGeneration ?? null,
        );
        this.runtime.publishProfile(record.profile);
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
    const compatibility = this.runtime.compatibility(
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
    for (const builtIn of this.runtime.builtInProfiles()) {
      if (builtIn.preset !== "kimi-code") continue;
      const status = await this.runtime.credentialStatus(builtIn.id, true);
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
      this.runtime.publishProfile(profile);
    }

    for (let stored of this.store.listModelBackendProfiles()) {
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
      nativeBackendProfile(providerId).id === selection.backendProfileId);
    if (nativeProvider) {
      return {
        profile: nativeProfile(nativeProvider, undefined),
        latestProbe: null,
      };
    }
    return this.store.modelBackendProfile(selection.backendProfileId);
  }

}
