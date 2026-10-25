import {
  backendProfilePrimaryModel,
  backendProfileProviderId,
  backendProfileRouteKind,
  backendProfileUsesCredential,
  modelBackendProfileDetailSchema,
  modelBackendProfileViewSchema,
  safeEndpointHost,
  type ModelBackendProfileDetail,
  type ModelBackendProfileView,
  type PersistedModelBackendProfile,
} from "../../../shared/backend-profile-settings";
import type { BackendCredentialStatus } from "../../../shared/backend-credentials";
import {
  claudeHarnessBackendCompatibility,
  claudeCompatibleBackendProfileSchema,
  createCustomClaudeBackendProfile,
  modelBackendProfileForClaudeProfile,
  type ClaudeCompatibleBackendProfile,
} from "../../../shared/claude-backend-profiles";
import type { BackendCompatibilityProbeResult } from "../../../shared/backend-probe";
import {
  BACKEND_CREDENTIAL_REQUIRED_MESSAGE,
  claudeBackendRequiresCredential,
  providerIdForHarness,
  resolveHarnessBackendCompatibility,
  type BackendAuthenticationMode,
  type HarnessBackendCompatibility,
} from "../../../shared/model-routing";
import type { ProviderId, ProviderInfo } from "../../../shared/contracts";
import { promptCacheTtlAllowed, type PromptCacheTtl } from "../../../shared/compact-on-return";
import { backendSecretReferenceForProfile } from "../../../node/backend-secret-reference";
import type { StoredModelBackendProfile } from "../../database";
import type {
  ProviderBackendLaunchOptions,
  ProviderManagerOptions,
  ProviderRunInput,
} from "../../provider/contracts";
import { ProviderManager } from "../../providers";
import {
  ClaudeBackendLaunchConfigurationError,
  createClaudeBackendLaunchResolver,
} from "./claude-compatible-adapter";
import { officialPresetEndpoint } from "./backend-profile-presets";
import {
  createCodexResponsesBackendLaunchResolver,
  type CodexResponsesBackendProfile,
} from "./codex-responses-adapter";
import {
  backendProbeForModel,
  connectionState,
  routingForClaude,
  safeBackendProfile,
} from "./backend-profile-model";
import {
  BackendProfileControllerError,
  type BackendCredentialBroker,
} from "./backend-profile-types";

function claudeLaunchAuthentication(
  mode: BackendAuthenticationMode,
): Exclude<BackendAuthenticationMode, "harness-managed" | "none"> {
  if (mode === "harness-managed" || mode === "none") {
    throw new BackendProfileControllerError(BACKEND_CREDENTIAL_REQUIRED_MESSAGE);
  }
  return mode;
}

export function backendKeyVerified(record: StoredModelBackendProfile): boolean {
  const keyCheck = record.probeKeyCheck ?? null;
  return keyCheck !== null && keyCheck.credentialGeneration === record.profile.credentialGeneration;
}

function incrementCount(counts: Map<string, number>, key: string): boolean {
  const current = counts.get(key) ?? 0;
  counts.set(key, current + 1);
  return current === 0;
}

function decrementCount(counts: Map<string, number>, key: string): boolean {
  const next = (counts.get(key) ?? 1) - 1;
  if (next > 0) {
    counts.set(key, next);
    return false;
  }
  counts.delete(key);
  return true;
}

export class BackendProfileRuntime {
  private readonly credentials: BackendCredentialBroker | undefined;
  private readonly builtInClaudeProfiles =
    new Map<string, ClaudeCompatibleBackendProfile>();
  private readonly secretReferences = new Map<string, string>();
  private readonly claudeProfiles =
    new Map<string, ClaudeCompatibleBackendProfile>();
  private readonly codexProfiles =
    new Map<string, CodexResponsesBackendProfile>();
  private readonly credentialStatuses =
    new Map<string, BackendCredentialStatus | null>();
  private readonly profileHarnessIds = new Map<string, string>();
  private readonly privateNetworkProfiles = new Set<string>();
  private readonly promptCacheTtls = new Map<string, PromptCacheTtl>();
  private readonly credentialRequiredProfiles = new Set<string>();
  private readonly activeProbes = new Map<string, number>();
  private readonly activeRenewals = new Map<string, number>();
  private readonly providerInfo = new Map<ProviderId, ProviderInfo>();
  private providers: ProviderManager | null = null;
  private providerMaintenanceBlocked: ((providerId: ProviderId) => boolean) | null = null;
  private readonly resolveClaudeLaunch;
  private readonly resolveCodexLaunch;
  private readonly now: () => Date;

  constructor(
    credentials: BackendCredentialBroker | undefined,
    builtInProfiles: readonly ClaudeCompatibleBackendProfile[],
    now: () => Date = () => new Date(),
  ) {
    this.credentials = credentials;
    this.now = now;
    for (const input of builtInProfiles) {
      const profile = claudeCompatibleBackendProfileSchema.parse(input);
      this.builtInClaudeProfiles.set(profile.id, profile);
      if (profile.secretReference) {
        this.secretReferences.set(profile.id, profile.secretReference);
      }
    }
    this.resolveClaudeLaunch = createClaudeBackendLaunchResolver({
      profiles: () => [...this.claudeProfiles.values()],
      resolveSecret: (reference, signal) =>
        this.resolveCredential(reference, signal),
      allowPrivateNetwork: (profileId) => this.privateNetworkProfiles.has(profileId),
    });
    this.resolveCodexLaunch = createCodexResponsesBackendLaunchResolver({
      profiles: () => [...this.codexProfiles.values()],
      resolveSecret: (reference, signal) =>
        this.resolveCredential(reference, signal),
    });
  }

  builtInProfiles(): IterableIterator<ClaudeCompatibleBackendProfile> {
    return this.builtInClaudeProfiles.values();
  }

  rememberProviders(providers: readonly ProviderInfo[]): void {
    for (const provider of providers) this.providerInfo.set(provider.id, provider);
  }

  provider(providerId: ProviderId): ProviderInfo | undefined {
    return this.providerInfo.get(providerId);
  }

  claudeProfile(profileId: string): ClaudeCompatibleBackendProfile | undefined {
    return this.claudeProfiles.get(profileId);
  }

  attachProviderManager(providers: ProviderManager): void {
    if (this.providers && this.providers !== providers) {
      throw new BackendProfileControllerError(
        "The backend profile controller is already attached.",
      );
    }
    this.providers = providers;
  }

  installationFingerprint(harnessId: string): string | null {
    const providerId = providerIdForHarness(harnessId);
    return providerId
      ? this.providers?.providerInstallationFingerprint(providerId) ?? null
      : null;
  }

  attachProviderMutationGuard(
    providerMaintenanceBlocked: (providerId: ProviderId) => boolean,
  ): void {
    if (
      this.providerMaintenanceBlocked
      && this.providerMaintenanceBlocked !== providerMaintenanceBlocked
    ) {
      throw new BackendProfileControllerError(
        "The backend profile maintenance guard is already attached.",
      );
    }
    this.providerMaintenanceBlocked = providerMaintenanceBlocked;
  }

  assertConfigurationMutable(harnessId: string): void {
    const providerId = providerIdForHarness(harnessId);
    if (!providerId) return;
    if (this.providerMaintenanceBlocked?.(providerId)) {
      throw new BackendProfileControllerError(
        "Provider configuration cannot change while maintenance owns it.",
      );
    }
    this.providers?.assertProviderConfigurationMutable(providerId);
  }

  providerManagerOptions(
    records: readonly StoredModelBackendProfile[],
  ): Pick<
    ProviderManagerOptions,
    | "backendProfiles"
    | "backendCompatibilities"
    | "backendProbeResults"
    | "backendProbeNow"
    | "resolveBackendLaunchOptions"
  > {
    // Startup maintenance recovery must run before credential reconciliation
    // mutates the store. Hydrate the read-only runtime projection here so the
    // ProviderManager still receives exact compatibility for profiles that
    // already exist, plus configured built-ins that initialization will
    // persist only after recovery has cleared admission.
    for (const { profile } of records) this.registerProfile(profile);
    const backendProfiles = records.map(({ profile }) =>
      safeBackendProfile(profile));
    const backendCompatibilities = records.flatMap((record) => {
      const { profile } = record;
      if (profile.source === "custom") return [];
      return [this.compatibility(
        profile,
        profile.routing.primaryModelId,
        backendProbeForModel(record, profile.routing.primaryModelId),
      )];
    });
    const registeredProfileIds = new Set(
      backendProfiles.map(({ id }) => id),
    );
    for (const builtIn of this.builtInClaudeProfiles.values()) {
      if (registeredProfileIds.has(builtIn.id)) continue;
      backendProfiles.push(modelBackendProfileForClaudeProfile(builtIn));
      backendCompatibilities.push(claudeHarnessBackendCompatibility(builtIn));
    }
    return {
      backendProfiles,
      backendCompatibilities,
      backendProbeResults: records.flatMap(({ probeResults }) => probeResults),
      backendProbeNow: this.now,
      resolveBackendLaunchOptions: (input, environment, context) =>
        this.resolveLaunch(input, environment, context),
    };
  }

  publishProfile(profile: PersistedModelBackendProfile): void {
    this.assertConfigurationMutable(profile.harnessId);
    this.registerProfile(profile);
    this.providers?.upsertBackendProfile(
      safeBackendProfile(profile),
      providerIdForHarness(profile.harnessId) ?? undefined,
    );
  }

  removeProfile(profileId: string): void {
    const harnessId = this.profileHarnessIds.get(profileId);
    if (harnessId) this.assertConfigurationMutable(harnessId);
    this.claudeProfiles.delete(profileId);
    this.codexProfiles.delete(profileId);
    this.promptCacheTtls.delete(profileId);
    this.credentialStatuses.delete(profileId);
    this.profileHarnessIds.delete(profileId);
    this.privateNetworkProfiles.delete(profileId);
    this.credentialRequiredProfiles.delete(profileId);
    this.providers?.removeBackendProfile(
      profileId,
      harnessId
        ? providerIdForHarness(harnessId) ?? undefined
        : undefined,
    );
  }

  beginProbe(profileId: string, renewal = false): boolean {
    return incrementCount(renewal ? this.activeRenewals : this.activeProbes, profileId);
  }

  endProbe(profileId: string, renewal = false): boolean {
    return decrementCount(renewal ? this.activeRenewals : this.activeProbes, profileId);
  }

  probing(profileId: string): boolean {
    return this.activeProbes.has(profileId);
  }

  renewing(profileId: string): boolean {
    return this.activeRenewals.has(profileId);
  }

  recordProbeResult(result: BackendCompatibilityProbeResult): void {
    this.providers?.recordBackendProbeResult(result);
  }

  async removeCredential(profileId: string): Promise<void> {
    await this.credentials?.forget(this.secretReference(profileId));
  }

  async forgetCredential(profileId: string): Promise<void> {
    await this.credentials?.forget(this.secretReference(profileId))
      .catch(() => false);
  }

  async credentialStatus(
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

  resolveCredential(
    reference: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return this.credentials?.resolve(reference, signal)
      ?? Promise.resolve(null);
  }

  secretReference(profileId: string): string {
    return this.secretReferences.get(profileId)
      ?? backendSecretReferenceForProfile(profileId);
  }

  view(record: StoredModelBackendProfile): ModelBackendProfileView {
    const profile = record.profile;
    const {
      baseUrl: _baseUrl,
      models: _models,
      ...profileWithoutBaseUrl
    } = profile;
    const status = this.credentialStatuses.get(profile.id);
    const models = profile.models.map((model) => {
      const latestProbe = backendProbeForModel(record, model.id);
      return {
        ...model,
        compatibility: this.compatibility(profile, model.id, latestProbe),
        latestProbe,
      };
    });
    const primary = models.find(({ id }) => id === profile.routing.primaryModelId);
    const primaryProbe = primary?.latestProbe ?? null;
    const compatibility = primary?.compatibility ?? this.compatibility(
      profile,
      profile.routing.primaryModelId,
      primaryProbe,
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
      models,
      routeKind: backendProfileRouteKind(profile),
      providerId: backendProfileProviderId(profile),
      endpointHost: safeEndpointHost(profile.baseUrl),
      authState,
      connectionState: profile.preset === "native"
        ? "connected"
        : this.probing(profile.id)
          ? "testing"
          : connectionState(primaryProbe),
      renewing: this.renewing(profile.id),
      keyVerified: backendKeyVerified(record),
      compatibility,
      latestProbe: primaryProbe,
      canDelete: profile.source === "custom",
      canDisable: profile.preset !== "native",
    });
  }

  detailView(record: StoredModelBackendProfile): ModelBackendProfileDetail {
    return modelBackendProfileDetailSchema.parse({
      ...this.view(record),
      baseUrl: record.profile.baseUrl,
    });
  }

  compatibility(
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
          { evaluatedAt: this.now(), modelId, probe },
        );
      }
    }
    const safeProfile = safeBackendProfile(profile);
    return resolveHarnessBackendCompatibility(
      profile.harnessId,
      safeProfile,
      {
        evaluatedAt: this.now(),
        modelId,
        probe,
        officialEndpoint: officialPresetEndpoint(safeProfile),
      },
    );
  }

  private registerProfile(profile: PersistedModelBackendProfile): void {
    this.profileHarnessIds.set(profile.id, profile.harnessId);
    if (profile.allowPrivateNetwork) this.privateNetworkProfiles.add(profile.id);
    else this.privateNetworkProfiles.delete(profile.id);
    if (profile.promptCacheTtl && promptCacheTtlAllowed(profile)) this.promptCacheTtls.set(profile.id, profile.promptCacheTtl);
    else this.promptCacheTtls.delete(profile.id);
    if (claudeBackendRequiresCredential(profile)) {
      this.credentialRequiredProfiles.add(profile.id);
      this.claudeProfiles.delete(profile.id);
      this.codexProfiles.delete(profile.id);
      return;
    }
    this.credentialRequiredProfiles.delete(profile.id);
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
          authenticationMode: claudeLaunchAuthentication(profile.authenticationMode),
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
        allowInsecureLocalhost: profile.allowInsecureLocalhost,
        allowPrivateNetwork: profile.allowPrivateNetwork,
      });
      this.claudeProfiles.delete(profile.id);
    }
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
      if (this.credentialRequiredProfiles.has(input.backendProfile.id)) {
        throw new ClaudeBackendLaunchConfigurationError(
          "credential-unavailable",
          BACKEND_CREDENTIAL_REQUIRED_MESSAGE,
        );
      }
      const promptCacheTtl = input.harnessId === "claude-agent-sdk"
        ? this.promptCacheTtls.get(input.backendProfile.id)
        : undefined;
      const launch = this.resolveClaudeLaunch(input, environment, context);
      if (!promptCacheTtl) return launch;
      const withPromptCache = (options: ProviderBackendLaunchOptions): ProviderBackendLaunchOptions => ({
        ...options,
        harnessConfiguration: { kind: "claude-messages", promptCacheTtl },
      });
      return launch instanceof Promise ? launch.then(withPromptCache) : withPromptCache(launch);
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
