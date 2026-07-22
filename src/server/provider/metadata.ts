import type {
  ProviderMetadataFieldState,
  ProviderMetadataProvenance,
  ProviderMetadataState,
  ProviderModel,
  ProviderRateLimit,
} from "../../shared/contracts";
import { readCodexMetadata } from "../codex-metadata";
import { readClaudeAgentSdkMetadata } from "./claude-agent-sdk-harness";
import type { ProviderAuthState, ProviderId } from "./contracts";
import { readOpenCodeSdkModels } from "./opencode-sdk-harness";

export type ProviderMetadataField = "models" | "rateLimits";

export interface ProviderMetadataValues {
  models: ProviderModel[];
  rateLimits: ProviderRateLimit[];
}

export interface ProviderMetadata extends ProviderMetadataValues {
  metadataState: ProviderMetadataState;
}

export interface ProviderMetadataReadResult {
  models?: ProviderModel[];
  rateLimits?: ProviderRateLimit[];
}

export interface PersistedProviderMetadata {
  providerId: ProviderId;
  executable: string | null;
  version: string | null;
  authState: ProviderAuthState | null;
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
}

interface CachedField<T> {
  values: T[];
  updatedAt: number | null;
  lastAttemptedAt: number | null;
  provenance: ProviderMetadataProvenance | null;
  stale: boolean;
}

interface CachedProviderMetadata {
  executable: string | null;
  version: string | null;
  authState: ProviderAuthState | null;
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
  opencode: ["models"],
};

const PROBE_FIELDS: Record<ProviderId, readonly ProviderMetadataField[]> = {
  codex: ["models", "rateLimits"],
  claude: ["models", "rateLimits"],
  cursor: [],
  opencode: ["models"],
};

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replaceAll("\0", "").trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function finitePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
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
    seen.add(id);
    const validated: ProviderModel = {
      id,
      label,
      description,
      isDefault: model.isDefault === true,
      inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
      reasoningOptions,
      defaultReasoningEffort: cleanString(model.defaultReasoningEffort, 40) ?? "",
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
    const usedPercent = finitePercent(limit.usedPercent);
    if (!id || usedPercent === undefined || seen.has(id)) return [];
    const reset = cleanString(limit.resetsAt, 64);
    const resetsAt = reset && !Number.isNaN(Date.parse(reset)) ? new Date(reset).toISOString() : null;
    const windowMinutes = typeof limit.windowMinutes === "number" && Number.isFinite(limit.windowMinutes) && limit.windowMinutes >= 0
      ? Math.min(limit.windowMinutes, 525_600)
      : null;
    seen.add(id);
    return [{
      id,
      label: cleanString(limit.label, 120) ?? id,
      usedPercent,
      remainingPercent: finitePercent(limit.remainingPercent) ?? Math.max(0, 100 - usedPercent),
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

function blankProvider(): CachedProviderMetadata {
  return { executable: null, version: null, authState: null, revision: 0, models: blankField(), rateLimits: blankField() };
}

function mergeById<T extends { id: string }>(previous: readonly T[], next: readonly T[]): T[] {
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of next) merged.set(item.id, item);
  return [...merged.values()];
}

function safePersistenceLoad(persistence: ProviderMetadataPersistence | undefined): readonly PersistedProviderMetadata[] {
  try { return persistence?.load() ?? []; } catch { return []; }
}

/** Provider-specific metadata access. Cache and persistence policy live in ProviderMetadataCache. */
export async function readProviderMetadata(
  providerId: ProviderId,
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  fields: readonly ProviderMetadataField[] = PROBE_FIELDS[providerId],
): Promise<ProviderMetadataReadResult> {
  if (providerId === "codex") return await readCodexMetadata(executable, environment, cwd, 6_000, fields);
  if (providerId === "claude") return await readClaudeAgentSdkMetadata(executable, environment, cwd, 6_000, undefined, fields);
  if (providerId === "opencode" && fields.includes("models")) {
    return { models: await readOpenCodeSdkModels(executable, environment, cwd) };
  }
  return {};
}

export class ProviderMetadataCache {
  private readonly entries = new Map<ProviderId, CachedProviderMetadata>();
  private readonly inFlight = new Map<ProviderId, InFlightRefresh>();
  private readonly persistence?: ProviderMetadataPersistence;
  private readonly reader: typeof readProviderMetadata;
  private readonly now: () => number;
  private readonly modelTtlMs: number;
  private readonly rateLimitTtlMs: number;

  constructor(options: ProviderMetadataCacheOptions = {}) {
    this.persistence = options.persistence;
    this.reader = options.read ?? readProviderMetadata;
    this.now = options.now ?? Date.now;
    this.modelTtlMs = Math.max(1_000, Math.min(options.modelTtlMs ?? DEFAULT_MODEL_TTL_MS, 24 * 60 * 60 * 1_000));
    this.rateLimitTtlMs = Math.max(1_000, Math.min(options.rateLimitTtlMs ?? DEFAULT_RATE_LIMIT_TTL_MS, 60 * 60 * 1_000));
    for (const cached of safePersistenceLoad(this.persistence)) this.hydrate(cached);
  }

  current(providerId: ProviderId): ProviderMetadata {
    const entry = this.entry(providerId);
    return {
      models: [...entry.models.values],
      rateLimits: [...entry.rateLimits.values],
      metadataState: {
        models: this.fieldState(providerId, "models", entry.models),
        rateLimits: this.fieldState(providerId, "rateLimits", entry.rateLimits),
      },
    };
  }

  invalidate(providerId: ProviderId, executable?: string | null): void {
    const entry = this.entry(providerId);
    const changedExecutable = executable !== undefined && executable !== entry.executable;
    if (executable !== undefined) entry.executable = executable;
    if (changedExecutable || executable === undefined) {
      entry.revision += 1;
      if (entry.models.values.length > 0) entry.models.stale = true;
      if (entry.rateLimits.values.length > 0) entry.rateLimits.stale = true;
      this.persist(providerId, entry);
    }
  }

  correlate(
    providerId: ProviderId,
    correlation: { executable: string | null; version: string | null; authState: ProviderAuthState },
  ): void {
    const entry = this.entry(providerId);
    const executable = cleanString(correlation.executable, 4_096) ?? null;
    const version = cleanString(correlation.version, 200) ?? null;
    const changed = entry.executable !== executable
      || (entry.version !== null && entry.version !== version)
      || (entry.authState !== null && entry.authState !== correlation.authState);
    entry.executable = executable;
    entry.version = version;
    entry.authState = correlation.authState;
    if (changed) {
      entry.revision += 1;
      if (entry.models.values.length > 0) entry.models.stale = true;
      if (entry.rateLimits.values.length > 0) entry.rateLimits.stale = true;
    }
    this.persist(providerId, entry);
  }

  learn(
    providerId: ProviderId,
    executable: string | null,
    metadata: ProviderMetadataReadResult,
    provenance: Exclude<ProviderMetadataProvenance, "persistent-cache">,
    options: { merge?: boolean } = {},
  ): ProviderMetadata {
    const entry = this.entry(providerId);
    if (executable && entry.executable !== executable) this.invalidate(providerId, executable);
    const attemptedAt = this.now();
    const models = validateProviderModels(metadata.models);
    const rateLimits = validateProviderRateLimits(metadata.rateLimits);
    let learned = false;
    if (models.length > 0 && AVAILABLE_FIELDS[providerId].includes("models")) {
      entry.models.values = options.merge ? mergeById(entry.models.values, models).slice(0, MAX_MODELS) : models;
      entry.models.updatedAt = attemptedAt;
      entry.models.lastAttemptedAt = attemptedAt;
      entry.models.provenance = provenance;
      entry.models.stale = false;
      learned = true;
    }
    if (rateLimits.length > 0 && AVAILABLE_FIELDS[providerId].includes("rateLimits")) {
      entry.rateLimits.values = options.merge ? mergeById(entry.rateLimits.values, rateLimits).slice(0, MAX_RATE_LIMITS) : rateLimits;
      entry.rateLimits.updatedAt = attemptedAt;
      entry.rateLimits.lastAttemptedAt = attemptedAt;
      entry.rateLimits.provenance = provenance;
      entry.rateLimits.stale = false;
      learned = true;
    }
    if (learned) entry.revision += 1;
    this.persist(providerId, entry);
    return this.current(providerId);
  }

  async metadata(
    providerId: ProviderId,
    executable: string,
    environment: NodeJS.ProcessEnv,
    cwd: string,
    options: ProviderMetadataRequestOptions = {},
  ): Promise<ProviderMetadata> {
    const available = new Set(AVAILABLE_FIELDS[providerId]);
    const probeable = new Set(PROBE_FIELDS[providerId]);
    const requested = [...new Set(options.fields ?? AVAILABLE_FIELDS[providerId])].filter(
      (field): field is ProviderMetadataField => available.has(field) && probeable.has(field),
    );
    const entry = this.entry(providerId);
    if (entry.executable !== executable) this.invalidate(providerId, executable);
    if (requested.length === 0) return this.current(providerId);

    const existing = this.inFlight.get(providerId);
    if (existing) {
      await existing.promise;
      if (existing.revision !== entry.revision) return await this.metadata(providerId, executable, environment, cwd, options);
      const missing = requested.filter((field) => !existing.fields.has(field));
      if (missing.length > 0) return await this.metadata(providerId, executable, environment, cwd, { ...options, fields: missing });
      return this.current(providerId);
    }

    const fields = options.force === true
      ? requested
      : requested.filter((field) => !this.isFresh(field, entry[field]));
    if (fields.length === 0) return this.current(providerId);

    const inFlightFields = new Set(fields);
    const revision = entry.revision;
    const promise = this.refresh(providerId, executable, environment, cwd, fields, revision).finally(() => {
      if (this.inFlight.get(providerId)?.promise === promise) this.inFlight.delete(providerId);
    });
    this.inFlight.set(providerId, { fields: inFlightFields, revision, promise });
    await promise;
    return this.current(providerId);
  }

  private async refresh(
    providerId: ProviderId,
    executable: string,
    environment: NodeJS.ProcessEnv,
    cwd: string,
    fields: readonly ProviderMetadataField[],
    revision: number,
  ): Promise<void> {
    const entry = this.entry(providerId);
    const attemptedAt = this.now();
    for (const field of fields) entry[field].lastAttemptedAt = attemptedAt;
    let result: ProviderMetadataReadResult;
    try {
      result = await this.reader(providerId, executable, environment, cwd, fields);
    } catch {
      if (entry.revision !== revision) return;
      for (const field of fields) if (entry[field].values.length > 0) entry[field].stale = true;
      this.persist(providerId, entry);
      return;
    }

    if (entry.revision !== revision) return;

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
    this.persist(providerId, entry);
  }

  private hydrate(cached: PersistedProviderMetadata): void {
    if (!Object.hasOwn(AVAILABLE_FIELDS, cached.providerId)) return;
    const models = validateProviderModels(cached.models);
    const rateLimits = validateProviderRateLimits(cached.rateLimits);
    const entry = blankProvider();
    entry.executable = cleanString(cached.executable, 4_096) ?? null;
    entry.version = cleanString(cached.version, 200) ?? null;
    entry.authState = cached.authState && AUTH_STATES.includes(cached.authState) ? cached.authState : null;
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
    this.entries.set(cached.providerId, entry);
  }

  private entry(providerId: ProviderId): CachedProviderMetadata {
    let entry = this.entries.get(providerId);
    if (!entry) {
      entry = blankProvider();
      this.entries.set(providerId, entry);
    }
    return entry;
  }

  private isFresh(field: ProviderMetadataField, cached: CachedField<unknown>): boolean {
    if (cached.values.length === 0 || cached.updatedAt === null || cached.stale) return false;
    const ttl = field === "models" ? this.modelTtlMs : this.rateLimitTtlMs;
    const age = this.now() - cached.updatedAt;
    return age >= 0 && age <= ttl;
  }

  private fieldState<T>(providerId: ProviderId, field: ProviderMetadataField, cached: CachedField<T>): ProviderMetadataFieldState {
    const supported = AVAILABLE_FIELDS[providerId].includes(field);
    return {
      freshness: !supported || cached.values.length === 0 ? "unavailable" : this.isFresh(field, cached) ? "fresh" : "stale",
      provenance: cached.values.length > 0 ? cached.provenance : null,
      updatedAt: isoTimestamp(cached.updatedAt),
      lastAttemptedAt: isoTimestamp(cached.lastAttemptedAt),
      refreshing: this.inFlight.get(providerId)?.fields.has(field) === true,
    };
  }

  private persist(providerId: ProviderId, entry: CachedProviderMetadata): void {
    if (!this.persistence) return;
    try {
      this.persistence.save({
        providerId,
        executable: entry.executable,
        version: entry.version,
        authState: entry.authState,
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
}
