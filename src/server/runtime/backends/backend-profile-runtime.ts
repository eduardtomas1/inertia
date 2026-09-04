import {
  backendProfilePrimaryModel,
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
  legacyProviderIdForHarness,
  resolveHarnessBackendCompatibility,
  type HarnessBackendCompatibility,
} from "../../../shared/model-routing";
import type { ProviderId, ProviderInfo } from "../../../shared/contracts";
import { backendSecretReferenceForProfile } from "../../../node/backend-secret-reference";
import type { StoredModelBackendProfile } from "../../database";
import type {
  ProviderBackendLaunchOptions,
  ProviderManagerOptions,
  ProviderRunInput,
} from "../../provider/contracts";
import { ProviderManager } from "../../providers";
import {
  createClaudeBackendLaunchResolver,
} from "./claude-compatible-adapter";
import {
  createCodexResponsesBackendLaunchResolver,
  type CodexResponsesBackendProfile,
} from "./codex-responses-adapter";
import {
  connectionState,
  routingForClaude,
  safeBackendProfile,
} from "./backend-profile-model";
import {
  BackendProfileControllerError,
  type BackendCredentialBroker,
} from "./backend-profile-types";

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
  private readonly providerInfo = new Map<ProviderId, ProviderInfo>();
  private providers: ProviderManager | null = null;
  private providerMaintenanceBlocked: ((providerId: ProviderId) => boolean) | null = null;
  private readonly resolveClaudeLaunch;
  private readonly resolveCodexLaunch;

  constructor(
    credentials: BackendCredentialBroker | undefined,
    builtInProfiles: readonly ClaudeCompatibleBackendProfile[],
  ) {
    this.credentials = credentials;
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
    const providerId = legacyProviderIdForHarness(harnessId);
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
    const backendCompatibilities = records.flatMap(({ profile, latestProbe }) => {
      if (profile.source === "custom") return [];
      return [this.compatibility(
        profile,
        profile.routing.primaryModelId,
        latestProbe,
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
      backendProbeResults: records.flatMap(({ latestProbe }) =>
        latestProbe ? [latestProbe] : []),
      resolveBackendLaunchOptions: (input, environment, context) =>
        this.resolveLaunch(input, environment, context),
    };
  }

  publishProfile(profile: PersistedModelBackendProfile): void {
    this.assertConfigurationMutable(profile.harnessId);
    this.registerProfile(profile);
    this.providers?.upsertBackendProfile(
      safeBackendProfile(profile),
      legacyProviderIdForHarness(profile.harnessId) ?? undefined,
    );
  }

  removeProfile(profileId: string): void {
    const harnessId = this.profileHarnessIds.get(profileId);
    if (harnessId) this.assertConfigurationMutable(harnessId);
    this.claudeProfiles.delete(profileId);
    this.codexProfiles.delete(profileId);
    this.credentialStatuses.delete(profileId);
    this.profileHarnessIds.delete(profileId);
    this.providers?.removeBackendProfile(
      profileId,
      harnessId
        ? legacyProviderIdForHarness(harnessId) ?? undefined
        : undefined,
    );
  }

  removeProbeResults(profileId: string): void {
    this.providers?.removeBackendProbeResults(profileId);
  }

  recordProbeResult(result: BackendCompatibilityProbeResult): void {
    this.providers?.recordBackendProbeResult(result);
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

  private registerProfile(profile: PersistedModelBackendProfile): void {
    this.profileHarnessIds.set(profile.id, profile.harnessId);
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
