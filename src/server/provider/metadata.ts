import type {
  KnownHarnessId,
  ModelBackendProfile,
  ModelSelection,
  ProviderMetadataFieldState,
  ProviderMetadataProvenance,
  ProviderMetadataState,
  ProviderModel,
  ProviderRateLimit,
} from "../../shared/contracts";
import {
  knownHarnessIdSchema,
  legacyProviderIdForHarness,
  nativeBackendProfile,
  nativeHarnessId,
} from "../../shared/model-routing";
import { readCodexMetadata } from "../codex-metadata";
import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import { readClaudeAgentSdkMetadata } from "./claude-agent-sdk-harness";
import type { ProviderAuthState, ProviderId } from "./contracts";
import { readOpenCodeSdkModels } from "./opencode-sdk-harness";
import { clampProviderPercent, providerTimestamp } from "./usage-values";

export type ProviderMetadataField = "models" | "rateLimits";

export interface ProviderMetadataValues {
  models: ProviderModel[];
  rateLimits: ProviderRateLimit[];
}

export interface ProviderMetadata extends ProviderMetadataValues {
  metadataState: ProviderMetadataState;
}

/**
 * Exact, non-secret identity for one metadata cache partition. Catalog reads
 * use `provider-catalog` as their model identity; run-emitted metadata uses
 * the selected model ID. Authentication is deliberately represented only by
 * public state. Credential values never participate in keys or persistence,
 * while credential replacement is covered by backendConfigurationRevision.
 */
export interface ProviderMetadataScope {
  providerId: ProviderId;
  harnessId: KnownHarnessId;
  backendProfileId: string;
  modelId: string;
  executable: string | null;
  version: string | null;
  backendConfigurationRevision: number;
  authState: ProviderAuthState;
}

export const PROVIDER_METADATA_CATALOG_MODEL_ID = "provider-catalog";

export interface ProviderMetadataReadResult {
  models?: ProviderModel[];
  rateLimits?: ProviderRateLimit[];
}

export interface PersistedProviderMetadata {
  scope: ProviderMetadataScope;
  models: ProviderModel[];
  modelsUpdatedAt: string | null;
  modelsLastAttemptedAt: string | null;
  modelsProvenance: ProviderMetadataProvenance | null;
  modelsStale: boolean;
  rateLimits: ProviderRateLimit[];
  rateLimitsUpdatedAt: string | null;
  rateLimitsLastAttemptedAt: string | null;
  rateLimitsProvenance: ProviderMetadataProvenance | null;
  rateLimitsStale: boolean;
}

export interface ProviderMetadataPersistence {
  load: () => readonly PersistedProviderMetadata[];
  save: (metadata: PersistedProviderMetadata) => void;
}

export interface ProviderMetadataCacheOptions {
  persistence?: ProviderMetadataPersistence;
  read?: typeof readProviderMetadata;
  now?: () => number;
  modelTtlMs?: number;
  rateLimitTtlMs?: number;
}

export interface ProviderMetadataRequestOptions {
  fields?: readonly ProviderMetadataField[];
  force?: boolean;
  /** Cancels the provider read and drains its owned process tree before settling. */
  signal?: AbortSignal;
}

interface CachedField<T> {
  values: T[];
  updatedAt: number | null;
  lastAttemptedAt: number | null;
  provenance: ProviderMetadataProvenance | null;
  stale: boolean;
}

interface CachedProviderMetadata {
  scope: ProviderMetadataScope;
  revision: number;
  models: CachedField<ProviderModel>;
  rateLimits: CachedField<ProviderRateLimit>;
}

interface InFlightRefresh {
  fields: Set<ProviderMetadataField>;
  revision: number;
  promise: Promise<void>;
}

// Provider docs do not prescribe polling intervals. These are conservative lifecycle policies:
// catalogs change slowly, while account usage benefits from a shorter refresh window.
const DEFAULT_MODEL_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_RATE_LIMIT_TTL_MS = 60 * 1_000;
const MAX_MODELS = 128;
const MAX_RATE_LIMITS = 16;
const AUTH_STATES: readonly ProviderAuthState[] = ["checking", "authenticated", "unauthenticated", "configured", "unknown", "error"];

const AVAILABLE_FIELDS: Record<ProviderId, readonly ProviderMetadataField[]> = {
  codex: ["models", "rateLimits"],
  claude: ["models", "rateLimits"],
  cursor: ["models"],
  kimi: ["models"],
  opencode: ["models"],
};

const PROBE_FIELDS: Record<ProviderId, readonly ProviderMetadataField[]> = {
  codex: ["models", "rateLimits"],
  claude: ["models", "rateLimits"],
  cursor: [],
  kimi: [],
  opencode: ["models"],
};

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replaceAll("\0", "").trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function normalizeProviderMetadataScope(
  input: ProviderMetadataScope,
): ProviderMetadataScope | null {
  if (!Object.hasOwn(AVAILABLE_FIELDS, input.providerId)) return null;
  const harness = knownHarnessIdSchema.safeParse(input.harnessId);
  const backendProfileId = cleanString(input.backendProfileId, 200);
  const modelId = cleanString(input.modelId, 300);
  const executable = cleanString(input.executable, 4_096) ?? null;
  const version = cleanString(input.version, 200) ?? null;
  if (
    !harness.success
    || legacyProviderIdForHarness(harness.data) !== input.providerId
    || !backendProfileId
    || !modelId
    || !Number.isSafeInteger(input.backendConfigurationRevision)
    || input.backendConfigurationRevision < 0
    || !AUTH_STATES.includes(input.authState)
  ) return null;
  return {
    providerId: input.providerId,
    harnessId: harness.data,
    backendProfileId,
    modelId,
    executable,
    version,
    backendConfigurationRevision: input.backendConfigurationRevision,
    authState: input.authState,
  };
}

export function providerMetadataScopeKey(scopeInput: ProviderMetadataScope): string {
  const scope = normalizeProviderMetadataScope(scopeInput);
  if (!scope) throw new Error("The provider metadata scope is invalid.");
  return JSON.stringify([
    scope.providerId,
    scope.harnessId,
    scope.backendProfileId,
    scope.modelId,
    scope.executable,
    scope.version,
    scope.backendConfigurationRevision,
    scope.authState,
  ]);
}

export function nativeProviderMetadataScope(
  providerId: ProviderId,
  correlation: Partial<
    Pick<ProviderMetadataScope, "executable" | "version" | "authState">
  > = {},
): ProviderMetadataScope {
  const backend = nativeBackendProfile(providerId);
  return {
    providerId,
    harnessId: nativeHarnessId(providerId),
    backendProfileId: backend.id,
    modelId: PROVIDER_METADATA_CATALOG_MODEL_ID,
    executable: cleanString(correlation.executable, 4_096) ?? null,
    version: cleanString(correlation.version, 200) ?? null,
    backendConfigurationRevision: backend.configurationRevision,
    authState: correlation.authState && AUTH_STATES.includes(correlation.authState)
      ? correlation.authState
      : "unknown",
  };
}

export function providerMetadataScopeForSelection(
  selection: ModelSelection,
  backendProfile: ModelBackendProfile,
  correlation: Pick<
    ProviderMetadataScope,
    "executable" | "version" | "authState"
  >,
): ProviderMetadataScope {
  const harness = knownHarnessIdSchema.parse(selection.harnessId);
  const providerId = legacyProviderIdForHarness(harness);
  if (
    !providerId
    || selection.backendProfileId !== backendProfile.id
    || selection.backendConfigurationRevision
      !== backendProfile.configurationRevision
  ) {
    throw new Error("The model selection does not match its metadata backend.");
  }
  const normalized = normalizeProviderMetadataScope({
    providerId,
    harnessId: harness,
    backendProfileId: backendProfile.id,
    modelId: selection.modelId,
    executable: correlation.executable,
    version: correlation.version,
    backendConfigurationRevision: backendProfile.configurationRevision,
    authState: correlation.authState,
  });
  if (!normalized) throw new Error("The provider metadata scope is invalid.");
  return normalized;
}

export function validateProviderModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const model = entry as Partial<ProviderModel>;
    const id = cleanString(model.id, 160);
    if (!id || seen.has(id)) return [];
    const label = cleanString(model.label, 120) ?? id;
    const description = cleanString(model.description, 300) ?? "Provider model";
    const inputModalities: ProviderModel["inputModalities"] = Array.isArray(model.inputModalities)
      ? [...new Set(model.inputModalities.filter((item): item is "text" | "image" => item === "text" || item === "image"))].slice(0, 2)
      : [];
    const reasoningSeen = new Set<string>();
    const reasoningOptions = (Array.isArray(model.reasoningOptions) ? model.reasoningOptions : []).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const option = candidate as Partial<ProviderModel["reasoningOptions"][number]>;
      const optionValue = cleanString(option.value, 40);
      if (!optionValue || reasoningSeen.has(optionValue)) return [];
      reasoningSeen.add(optionValue);
      return [{
        value: optionValue,
        label: cleanString(option.label, 80) ?? optionValue,
        description: cleanString(option.description, 240) ?? `${optionValue} reasoning`,
      }];
    }).slice(0, 12);
    const fastModeInput = model.fastMode;
    const fastMode = fastModeInput
      && typeof fastModeInput === "object"
      && !Array.isArray(fastModeInput)
      ? (() => {
          const providerValue = cleanString(fastModeInput.providerValue, 40);
          const fastLabel = cleanString(fastModeInput.label, 80);
          const fastDescription = cleanString(fastModeInput.description, 240);
          if (!providerValue || !fastLabel || !fastDescription) return null;
          return {
            providerValue,
            label: fastLabel,
            description: fastDescription,
            isDefault: fastModeInput.isDefault === true,
          };
        })()
      : null;
    seen.add(id);
    const validated: ProviderModel = {
      id,
      label,
      description,
      isDefault: model.isDefault === true,
      inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
      reasoningOptions,
      defaultReasoningEffort: cleanString(model.defaultReasoningEffort, 40) ?? "",
      fastMode,
    };
    return [validated];
  }).slice(0, MAX_MODELS);
}

export function validateProviderRateLimits(value: unknown): ProviderRateLimit[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const limit = entry as Partial<ProviderRateLimit>;
    const id = cleanString(limit.id, 120);
    const usedPercent = clampProviderPercent(limit.usedPercent);
    if (!id || usedPercent === null || seen.has(id)) return [];
    const resetsAt = providerTimestamp(limit.resetsAt);
    const windowMinutes = typeof limit.windowMinutes === "number" && Number.isFinite(limit.windowMinutes) && limit.windowMinutes >= 0
      ? Math.min(limit.windowMinutes, 525_600)
      : null;
    seen.add(id);
    return [{
      id,
      label: cleanString(limit.label, 120) ?? id,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowMinutes,
      resetsAt,
    }];
  }).slice(0, MAX_RATE_LIMITS);
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function blankField<T>(): CachedField<T> {
  return { values: [], updatedAt: null, lastAttemptedAt: null, provenance: null, stale: false };
}

function blankProvider(scope: ProviderMetadataScope): CachedProviderMetadata {
  return { scope, revision: 0, models: blankField(), rateLimits: blankField() };
}

function mergeById<T extends { id: string }>(previous: readonly T[], next: readonly T[]): T[] {
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of next) merged.set(item.id, item);
  return [...merged.values()];
}

function safePersistenceLoad(persistence: ProviderMetadataPersistence | undefined): readonly PersistedProviderMetadata[] {
  try { return persistence?.load() ?? []; } catch { return []; }
}

function staleClone<T>(field: CachedField<T>): CachedField<T> {
  return {
    values: [...field.values],
    updatedAt: field.updatedAt,
    lastAttemptedAt: field.lastAttemptedAt,
    provenance: field.provenance,
    stale: field.values.length > 0 || field.stale,
  };
}

function latestEntryTimestamp(entry: CachedProviderMetadata): number {
  return Math.max(
    entry.models.updatedAt ?? 0,
    entry.models.lastAttemptedAt ?? 0,
    entry.rateLimits.updatedAt ?? 0,
    entry.rateLimits.lastAttemptedAt ?? 0,
  );
}

/** Provider-specific metadata access. Cache and persistence policy live in ProviderMetadataCache. */
export async function readProviderMetadata(
  providerId: ProviderId,
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  fields: readonly ProviderMetadataField[] = PROBE_FIELDS[providerId],
  signal?: AbortSignal,
): Promise<ProviderMetadataReadResult> {
  if (providerId === "codex") return await readCodexMetadata(executable, environment, cwd, 6_000, fields, { signal });
  if (providerId === "claude") return await readClaudeAgentSdkMetadata(executable, environment, cwd, 6_000, undefined, fields, {}, signal);
  if (providerId === "opencode" && fields.includes("models")) {
    return { models: await readOpenCodeSdkModels(executable, environment, cwd, { signal }) };
  }
  return {};
}

export class ProviderMetadataCache {
  private readonly entries = new Map<string, CachedProviderMetadata>();
  private readonly nativeScopeKeys = new Map<ProviderId, string>();
  private readonly inFlight = new Map<string, InFlightRefresh>();
  private readonly persistence?: ProviderMetadataPersistence;
  private readonly reader: typeof readProviderMetadata;
  private readonly now: () => number;
  private readonly modelTtlMs: number;
  private readonly rateLimitTtlMs: number;
  private cleanupUnconfirmed = false;

  constructor(options: ProviderMetadataCacheOptions = {}) {
    this.persistence = options.persistence;
    this.reader = options.read ?? readProviderMetadata;
    this.now = options.now ?? Date.now;
    this.modelTtlMs = Math.max(1_000, Math.min(options.modelTtlMs ?? DEFAULT_MODEL_TTL_MS, 24 * 60 * 60 * 1_000));
    this.rateLimitTtlMs = Math.max(1_000, Math.min(options.rateLimitTtlMs ?? DEFAULT_RATE_LIMIT_TTL_MS, 60 * 60 * 1_000));
    for (const cached of safePersistenceLoad(this.persistence)) this.hydrate(cached);
    for (const providerId of Object.keys(AVAILABLE_FIELDS) as ProviderId[]) {
      if (this.nativeScopeKeys.has(providerId)) continue;
      const scope = nativeProviderMetadataScope(providerId);
      this.nativeScopeKeys.set(providerId, providerMetadataScopeKey(scope));
    }
  }

  current(providerId: ProviderId): ProviderMetadata {
    return this.currentScoped(this.nativeScope(providerId));
  }

  processCleanupConfirmed(): boolean {
    return !this.cleanupUnconfirmed;
  }

  currentScoped(scopeInput: ProviderMetadataScope): ProviderMetadata {
    const scope = this.requireScope(scopeInput);
    const key = providerMetadataScopeKey(scope);
    const entry = this.entry(scope);
    return {
      models: [...entry.models.values],
      rateLimits: [...entry.rateLimits.values],
      metadataState: {
        models: this.fieldState(scope.providerId, key, "models", entry.models),
        rateLimits: this.fieldState(
          scope.providerId,
          key,
          "rateLimits",
          entry.rateLimits,
        ),
      },
    };
  }

  /**
   * Returns the exact native catalog correlation currently projected into the
   * legacy ProviderInfo shell. Callers may reuse its public executable,
   * version, and auth state when constructing a model-specific route scope.
   */
  nativeScope(providerId: ProviderId): ProviderMetadataScope {
    const key = this.nativeScopeKeys.get(providerId);
    return key && this.entries.get(key)
      ? { ...this.entries.get(key)!.scope }
      : nativeProviderMetadataScope(providerId);
  }

  scopeForSelection(
    selection: ModelSelection,
    backendProfile: ModelBackendProfile,
    executable?: string | null,
  ): ProviderMetadataScope {
    const providerId = legacyProviderIdForHarness(selection.harnessId);
    if (!providerId) throw new Error("The model selection harness is unknown.");
    const native = this.nativeScope(providerId);
    const nativeBackend = nativeBackendProfile(providerId);
    const selectedExecutable = cleanString(executable, 4_096) ?? null;
    const sharesNativeExecutable = selectedExecutable === native.executable;
    const ownsNativeAuthentication = backendProfile.id === nativeBackend.id
      && backendProfile.configurationRevision
        === nativeBackend.configurationRevision
      && backendProfile.authenticationMode === "harness-managed";
    return providerMetadataScopeForSelection(selection, backendProfile, {
      executable: selectedExecutable,
      version: sharesNativeExecutable ? native.version : null,
      authState: ownsNativeAuthentication && sharesNativeExecutable
        ? native.authState
        : backendProfile.authenticationMode === "harness-managed"
          ? "unknown"
          : "configured",
    });
  }

  invalidate(providerId: ProviderId, executable?: string | null): void {
    const currentScope = this.nativeScope(providerId);
    if (
      executable !== undefined
      && (cleanString(executable, 4_096) ?? null) !== currentScope.executable
    ) {
      this.switchNativeScope(nativeProviderMetadataScope(providerId, {
        executable,
        version: null,
        authState: "unknown",
      }));
      return;
    }
    const entry = this.entry(currentScope);
    entry.revision += 1;
    if (entry.models.values.length > 0) entry.models.stale = true;
    if (entry.rateLimits.values.length > 0) entry.rateLimits.stale = true;
    this.persist(entry);
  }

  correlate(
    providerId: ProviderId,
    correlation: { executable: string | null; version: string | null; authState: ProviderAuthState },
  ): void {
    this.switchNativeScope(nativeProviderMetadataScope(providerId, correlation));
  }

  learn(
    providerId: ProviderId,
    executable: string | null,
    metadata: ProviderMetadataReadResult,
    provenance: Exclude<ProviderMetadataProvenance, "persistent-cache">,
    options: { merge?: boolean } = {},
  ): ProviderMetadata {
    const normalizedExecutable = cleanString(executable, 4_096) ?? null;
    if (normalizedExecutable !== this.nativeScope(providerId).executable) {
      this.switchNativeScope(nativeProviderMetadataScope(providerId, {
        executable: normalizedExecutable,
        version: null,
        authState: "unknown",
      }));
    }
    return this.learnScoped(
      this.nativeScope(providerId),
      metadata,
      provenance,
      options,
    );
  }

  learnScoped(
    scopeInput: ProviderMetadataScope,
    metadata: ProviderMetadataReadResult,
    provenance: Exclude<ProviderMetadataProvenance, "persistent-cache">,
    options: { merge?: boolean } = {},
  ): ProviderMetadata {
    const scope = this.requireScope(scopeInput);
    const entry = this.entry(scope);
    const attemptedAt = this.now();
    const models = validateProviderModels(metadata.models);
    const rateLimits = validateProviderRateLimits(metadata.rateLimits);
    let learned = false;
    if (models.length > 0 && AVAILABLE_FIELDS[scope.providerId].includes("models")) {
      entry.models.values = options.merge ? mergeById(entry.models.values, models).slice(0, MAX_MODELS) : models;
      entry.models.updatedAt = attemptedAt;
      entry.models.lastAttemptedAt = attemptedAt;
      entry.models.provenance = provenance;
      entry.models.stale = false;
      learned = true;
    }
    if (
      rateLimits.length > 0
      && AVAILABLE_FIELDS[scope.providerId].includes("rateLimits")
    ) {
      entry.rateLimits.values = options.merge ? mergeById(entry.rateLimits.values, rateLimits).slice(0, MAX_RATE_LIMITS) : rateLimits;
      entry.rateLimits.updatedAt = attemptedAt;
      entry.rateLimits.lastAttemptedAt = attemptedAt;
      entry.rateLimits.provenance = provenance;
      entry.rateLimits.stale = false;
      learned = true;
    }
    if (learned) entry.revision += 1;
    this.persist(entry);
    return this.currentScoped(scope);
  }

  async metadata(
    providerId: ProviderId,
    executable: string,
    environment: NodeJS.ProcessEnv,
    cwd: string,
    options: ProviderMetadataRequestOptions = {},
  ): Promise<ProviderMetadata> {
    if ((cleanString(executable, 4_096) ?? null) !== this.nativeScope(providerId).executable) {
      this.switchNativeScope(nativeProviderMetadataScope(providerId, {
        executable,
        version: null,
        authState: "unknown",
      }));
    }
    return await this.metadataScoped(
      this.nativeScope(providerId),
      environment,
      cwd,
      options,
    );
  }

  async metadataScoped(
    scopeInput: ProviderMetadataScope,
    environment: NodeJS.ProcessEnv,
    cwd: string,
    options: ProviderMetadataRequestOptions = {},
  ): Promise<ProviderMetadata> {
    const scope = this.requireScope(scopeInput);
    if (!scope.executable) return this.currentScoped(scope);
    if (options.signal?.aborted) return this.currentScoped(scope);
    const available = new Set(AVAILABLE_FIELDS[scope.providerId]);
    const probeable = new Set(PROBE_FIELDS[scope.providerId]);
    const requested = [
      ...new Set(options.fields ?? AVAILABLE_FIELDS[scope.providerId]),
    ].filter(
      (field): field is ProviderMetadataField => available.has(field) && probeable.has(field),
    );
    const key = providerMetadataScopeKey(scope);
    const entry = this.entry(scope);
    if (requested.length === 0) return this.currentScoped(scope);

    const existing = this.inFlight.get(key);
    if (existing) {
      await existing.promise;
      if (existing.revision !== entry.revision) {
        return await this.metadataScoped(scope, environment, cwd, options);
      }
      const missing = requested.filter((field) => !existing.fields.has(field));
      if (missing.length > 0) {
        return await this.metadataScoped(
          scope,
          environment,
          cwd,
          { ...options, fields: missing },
        );
      }
      return this.currentScoped(scope);
    }

    const fields = options.force === true
      ? requested
      : requested.filter((field) => !this.isFresh(field, entry[field]));
    if (fields.length === 0) return this.currentScoped(scope);

    const inFlightFields = new Set(fields);
    const revision = entry.revision;
    const promise = this.refresh(
      scope,
      environment,
      cwd,
      fields,
      revision,
      options.signal,
    )
      .finally(() => {
        if (this.inFlight.get(key)?.promise === promise) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, { fields: inFlightFields, revision, promise });
    await promise;
    return this.currentScoped(scope);
  }

  private async refresh(
    scope: ProviderMetadataScope,
    environment: NodeJS.ProcessEnv,
    cwd: string,
    fields: readonly ProviderMetadataField[],
    revision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.entry(scope);
    const attemptedAt = this.now();
    let result: ProviderMetadataReadResult;
    try {
      result = await this.reader(
        scope.providerId,
        scope.executable!,
        environment,
        cwd,
        fields,
        signal,
      );
    } catch (error) {
      this.cleanupUnconfirmed ||= isProcessTreeTerminationUnconfirmed(error);
      if (signal?.aborted) return;
      if (entry.revision !== revision) return;
      for (const field of fields) entry[field].lastAttemptedAt = attemptedAt;
      for (const field of fields) if (entry[field].values.length > 0) entry[field].stale = true;
      this.persist(entry);
      return;
    }

    if (entry.revision !== revision) return;
    for (const field of fields) entry[field].lastAttemptedAt = attemptedAt;

    for (const field of fields) {
      const values = field === "models" ? validateProviderModels(result.models) : validateProviderRateLimits(result.rateLimits);
      if (values.length === 0) {
        if (entry[field].values.length > 0) entry[field].stale = true;
        continue;
      }
      if (field === "models") entry.models.values = values as ProviderModel[];
      else entry.rateLimits.values = values as ProviderRateLimit[];
      entry[field].updatedAt = attemptedAt;
      entry[field].provenance = "provider";
      entry[field].stale = false;
    }
    this.persist(entry);
  }

  private hydrate(cached: PersistedProviderMetadata): void {
    const scope = normalizeProviderMetadataScope(cached.scope);
    if (!scope) return;
    const models = validateProviderModels(cached.models);
    const rateLimits = validateProviderRateLimits(cached.rateLimits);
    const entry = blankProvider(scope);
    entry.models = {
      values: models,
      updatedAt: models.length > 0 ? timestamp(cached.modelsUpdatedAt) : null,
      lastAttemptedAt: timestamp(cached.modelsLastAttemptedAt),
      provenance: models.length > 0 ? "persistent-cache" : null,
      stale: cached.modelsStale === true,
    };
    entry.rateLimits = {
      values: rateLimits,
      updatedAt: rateLimits.length > 0 ? timestamp(cached.rateLimitsUpdatedAt) : null,
      lastAttemptedAt: timestamp(cached.rateLimitsLastAttemptedAt),
      provenance: rateLimits.length > 0 ? "persistent-cache" : null,
      stale: cached.rateLimitsStale === true,
    };
    const key = providerMetadataScopeKey(scope);
    this.entries.set(key, entry);
    if (!this.isNativeCatalogScope(scope)) return;
    const currentKey = this.nativeScopeKeys.get(scope.providerId);
    const current = currentKey ? this.entries.get(currentKey) : undefined;
    if (!current || latestEntryTimestamp(entry) >= latestEntryTimestamp(current)) {
      this.nativeScopeKeys.set(scope.providerId, key);
    }
  }

  private entry(scopeInput: ProviderMetadataScope): CachedProviderMetadata {
    const scope = this.requireScope(scopeInput);
    const key = providerMetadataScopeKey(scope);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = blankProvider(scope);
      this.entries.set(key, entry);
    }
    return entry;
  }

  private isFresh(field: ProviderMetadataField, cached: CachedField<unknown>): boolean {
    if (cached.values.length === 0 || cached.updatedAt === null || cached.stale) return false;
    const ttl = field === "models" ? this.modelTtlMs : this.rateLimitTtlMs;
    const age = this.now() - cached.updatedAt;
    return age >= 0 && age <= ttl;
  }

  private fieldState<T>(
    providerId: ProviderId,
    scopeKey: string,
    field: ProviderMetadataField,
    cached: CachedField<T>,
  ): ProviderMetadataFieldState {
    const supported = AVAILABLE_FIELDS[providerId].includes(field);
    return {
      freshness: !supported || cached.values.length === 0 ? "unavailable" : this.isFresh(field, cached) ? "fresh" : "stale",
      provenance: cached.values.length > 0 ? cached.provenance : null,
      updatedAt: isoTimestamp(cached.updatedAt),
      lastAttemptedAt: isoTimestamp(cached.lastAttemptedAt),
      refreshing: this.inFlight.get(scopeKey)?.fields.has(field) === true,
    };
  }

  private persist(entry: CachedProviderMetadata): void {
    if (!this.persistence) return;
    try {
      this.persistence.save({
        scope: entry.scope,
        models: entry.models.values,
        modelsUpdatedAt: isoTimestamp(entry.models.updatedAt),
        modelsLastAttemptedAt: isoTimestamp(entry.models.lastAttemptedAt),
        modelsProvenance: entry.models.provenance,
        modelsStale: entry.models.stale,
        rateLimits: entry.rateLimits.values,
        rateLimitsUpdatedAt: isoTimestamp(entry.rateLimits.updatedAt),
        rateLimitsLastAttemptedAt: isoTimestamp(entry.rateLimits.lastAttemptedAt),
        rateLimitsProvenance: entry.rateLimits.provenance,
        rateLimitsStale: entry.rateLimits.stale,
      });
    } catch {
      // Metadata remains available in memory when the best-effort durable cache cannot be written.
    }
  }

  private requireScope(scope: ProviderMetadataScope): ProviderMetadataScope {
    const normalized = normalizeProviderMetadataScope(scope);
    if (!normalized) throw new Error("The provider metadata scope is invalid.");
    return normalized;
  }

  private isNativeCatalogScope(scope: ProviderMetadataScope): boolean {
    const backend = nativeBackendProfile(scope.providerId);
    return scope.harnessId === nativeHarnessId(scope.providerId)
      && scope.backendProfileId === backend.id
      && scope.backendConfigurationRevision === backend.configurationRevision
      && scope.modelId === PROVIDER_METADATA_CATALOG_MODEL_ID;
  }

  private switchNativeScope(scopeInput: ProviderMetadataScope): void {
    const scope = this.requireScope(scopeInput);
    if (!this.isNativeCatalogScope(scope)) {
      throw new Error("Only a native provider catalog can become the legacy metadata scope.");
    }
    const key = providerMetadataScopeKey(scope);
    const previousKey = this.nativeScopeKeys.get(scope.providerId);
    if (previousKey === key) {
      const entry = this.entry(scope);
      this.persist(entry);
      return;
    }
    const previous = previousKey ? this.entries.get(previousKey) : undefined;
    let next = this.entries.get(key);
    if (!next) {
      next = previous
        ? {
            scope,
            revision: previous.revision + 1,
            models: staleClone(previous.models),
            rateLimits: staleClone(previous.rateLimits),
          }
        : blankProvider(scope);
      this.entries.set(key, next);
    } else if (previous) {
      if (next.models.values.length === 0 && previous.models.values.length > 0) {
        next.models = staleClone(previous.models);
      }
      if (
        next.rateLimits.values.length === 0
        && previous.rateLimits.values.length > 0
      ) {
        next.rateLimits = staleClone(previous.rateLimits);
      }
      next.revision += 1;
    }
    this.nativeScopeKeys.set(scope.providerId, key);
    this.persist(next);
  }
}
