import { z } from "zod";

import type { ProviderId } from "../provider";

/**
 * Shared vocabulary for Auto routing. A picker only ever outputs a tier and a
 * task kind; the runtime maps tiers to validated catalog entries, so a picker
 * can never name a model that the user's providers do not advertise.
 */
export const ROUTING_TIERS = ["light", "standard", "heavy", "max"] as const;
export type RoutingTier = (typeof ROUTING_TIERS)[number];

export const ROUTING_TASK_KINDS = [
  "question",
  "small_edit",
  "feature",
  "debugging",
  "review",
  "research",
  "planning",
  "other",
] as const;
export type RoutingTaskKind = (typeof ROUTING_TASK_KINDS)[number];

export const ROUTING_WEIGHTS = ["prefer", "normal", "less", "never"] as const;
export type RoutingWeight = (typeof ROUTING_WEIGHTS)[number];

/** Append-only: later releases add "jev" and "model". */
export const ROUTING_PICKERS = ["rules"] as const;
export type RoutingPickerId = (typeof ROUTING_PICKERS)[number];

export const ROUTING_STICKINESS_MODES = ["sticky", "rebalance"] as const;
export type RoutingStickiness = (typeof ROUTING_STICKINESS_MODES)[number];

export const ROUTING_MODES = ["manual", "auto"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const ROUTING_OUTCOMES = ["applied", "kept", "fallback", "low-confidence"] as const;
export type RoutingOutcome = (typeof ROUTING_OUTCOMES)[number];

export const ROUTING_PROVIDER_IDS = [
  "codex",
  "claude",
  "cursor",
  "kimi",
  "opencode",
  "antigravity",
] as const satisfies readonly ProviderId[];

export const MAX_ROUTING_PRESETS_PER_TIER = 24;
export const ROUTING_SETTINGS_JSON_MAX_LENGTH = 65_536;
export const ROUTING_DECISION_JSON_MAX_LENGTH = 4_096;
export const ROUTING_REASON_MAX_LENGTH = 300;
export const ROUTING_CONFIDENCE_THRESHOLD_MIN = 0;
export const ROUTING_CONFIDENCE_THRESHOLD_MAX = 1;
/** The Settings control offers the useful middle of the range. */
export const ROUTING_CONFIDENCE_CONTROL_MIN = 0.3;
export const ROUTING_CONFIDENCE_CONTROL_MAX = 0.9;
export const ROUTING_QUOTA_RESERVE_MIN = 0;
export const ROUTING_QUOTA_RESERVE_MAX = 90;

export const ROUTING_TIER_LABELS: Readonly<Record<RoutingTier, string>> = {
  light: "Light",
  standard: "Standard",
  heavy: "Heavy",
  max: "Max",
};

export const ROUTING_TASK_KIND_LABELS: Readonly<Record<RoutingTaskKind, string>> = {
  question: "Question",
  small_edit: "Small edit",
  feature: "Feature work",
  debugging: "Debugging",
  review: "Review",
  research: "Research",
  planning: "Planning",
  other: "General",
};

export const ROUTING_PICKER_DESCRIPTIONS: Readonly<Record<RoutingPickerId, string>> = {
  rules: "Built-in rules read the message locally (length, code, attachments, keywords). Nothing leaves this device.",
};

export const ROUTING_WEIGHT_LABELS: Readonly<Record<RoutingWeight, string>> = {
  prefer: "Prefer",
  normal: "Normal",
  less: "Less often",
  never: "Never",
};

export interface RoutingPreset {
  providerId: ProviderId;
  backendProfileId: string;
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  weight: RoutingWeight;
}

export interface RoutingTierSettings {
  /** null means "derive defaults from the live provider catalog". */
  presets: RoutingPreset[] | null;
}

export interface RoutingSettings {
  enabled: boolean;
  autoForNewChats: boolean;
  picker: RoutingPickerId;
  confidenceThreshold: number;
  fallbackTier: RoutingTier;
  stickiness: RoutingStickiness;
  quotaReservePercent: number;
  tiers: Record<RoutingTier, RoutingTierSettings>;
}

export type RoutingSettingsUpdate = Partial<Omit<RoutingSettings, "tiers">> & {
  tiers?: Partial<Record<RoutingTier, RoutingTierSettings>>;
};

export interface RoutingRouteReference {
  providerId: ProviderId;
  modelId: string;
  reasoningEffort: string | null;
}

/** Bounded, renderer-safe record of one Auto routing decision. */
export interface RoutingDecisionSummary {
  picker: RoutingPickerId;
  tier: RoutingTier;
  taskKind: RoutingTaskKind;
  confidence: number;
  outcome: RoutingOutcome;
  reason: string;
  previousRoute: RoutingRouteReference | null;
}

export function defaultRoutingSettings(): RoutingSettings {
  return {
    enabled: false,
    autoForNewChats: false,
    picker: "rules",
    confidenceThreshold: 0.5,
    fallbackTier: "standard",
    stickiness: "sticky",
    quotaReservePercent: 10,
    tiers: {
      light: { presets: null },
      standard: { presets: null },
      heavy: { presets: null },
      max: { presets: null },
    },
  };
}

export const DEFAULT_ROUTING_SETTINGS: Readonly<RoutingSettings> = Object.freeze(defaultRoutingSettings());

const routingProfileIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z][A-Za-z0-9._:-]*$/u);
// Model identities stay printable and quote-free so stored JSON never expands.
const routingModelIdSchema = z.string().min(1).max(200).regex(/^[^\s"\\\u0000-\u001f\u007f]+$/u);
const routingEffortSchema = z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/u);

export const routingTierSchema = z.enum(ROUTING_TIERS);
export const routingTaskKindSchema = z.enum(ROUTING_TASK_KINDS);
export const routingModeSchema = z.enum(ROUTING_MODES);

export const routingPresetSchema = z.strictObject({
  providerId: z.enum(ROUTING_PROVIDER_IDS),
  backendProfileId: routingProfileIdSchema,
  modelId: routingModelIdSchema,
  reasoningEffort: routingEffortSchema.nullable(),
  fastMode: z.boolean(),
  weight: z.enum(ROUTING_WEIGHTS),
});

export const routingTierSettingsSchema = z.strictObject({
  presets: z.array(routingPresetSchema).max(MAX_ROUTING_PRESETS_PER_TIER).nullable(),
});

const confidenceThresholdSchema = z.number()
  .min(ROUTING_CONFIDENCE_THRESHOLD_MIN)
  .max(ROUTING_CONFIDENCE_THRESHOLD_MAX);
const quotaReserveSchema = z.number().int().min(ROUTING_QUOTA_RESERVE_MIN).max(ROUTING_QUOTA_RESERVE_MAX);

const routingScalarShape = {
  enabled: z.boolean(),
  autoForNewChats: z.boolean(),
  picker: z.enum(ROUTING_PICKERS),
  confidenceThreshold: confidenceThresholdSchema,
  fallbackTier: routingTierSchema,
  stickiness: z.enum(ROUTING_STICKINESS_MODES),
  quotaReservePercent: quotaReserveSchema,
};

export const routingSettingsSchema = z.strictObject({
  ...routingScalarShape,
  tiers: z.strictObject({
    light: routingTierSettingsSchema,
    standard: routingTierSettingsSchema,
    heavy: routingTierSettingsSchema,
    max: routingTierSettingsSchema,
  }),
});

/** Partial update accepted by `settings.update`; unknown keys are refused. */
export const routingSettingsUpdateSchema = z.strictObject({
  enabled: routingScalarShape.enabled.optional(),
  autoForNewChats: routingScalarShape.autoForNewChats.optional(),
  picker: routingScalarShape.picker.optional(),
  confidenceThreshold: routingScalarShape.confidenceThreshold.optional(),
  fallbackTier: routingScalarShape.fallbackTier.optional(),
  stickiness: routingScalarShape.stickiness.optional(),
  quotaReservePercent: routingScalarShape.quotaReservePercent.optional(),
  tiers: z.strictObject({
    light: routingTierSettingsSchema.optional(),
    standard: routingTierSettingsSchema.optional(),
    heavy: routingTierSettingsSchema.optional(),
    max: routingTierSettingsSchema.optional(),
  }).optional(),
});

// Mirrors modelSelectionSchema's bounds so any stored selection can be referenced;
// an empty effort means "provider default" and is stored as null.
const routingRouteReferenceSchema = z.strictObject({
  providerId: z.enum(ROUTING_PROVIDER_IDS),
  modelId: z.string().min(1).max(300),
  reasoningEffort: z.string().max(100).nullable().transform((value) => value === "" ? null : value),
});

export const routingDecisionSummarySchema = z.strictObject({
  picker: z.enum(ROUTING_PICKERS),
  tier: routingTierSchema,
  taskKind: routingTaskKindSchema,
  confidence: z.number().min(0).max(1),
  outcome: z.enum(ROUTING_OUTCOMES),
  reason: z.string().max(ROUTING_REASON_MAX_LENGTH),
  previousRoute: routingRouteReferenceSchema.nullable(),
});

export function isRoutingSettings(value: unknown): value is RoutingSettings {
  return routingSettingsSchema.safeParse(value).success;
}

export function isRoutingDecisionSummary(value: unknown): value is RoutingDecisionSummary {
  return routingDecisionSummarySchema.safeParse(value).success;
}

function cloneTier(tier: RoutingTierSettings): RoutingTierSettings {
  return { presets: tier.presets === null ? null : tier.presets.map((preset) => ({ ...preset })) };
}

/** Repairs stored settings field by field; a corrupt tier falls back to derived defaults. */
export function parseRoutingSettings(value: unknown): RoutingSettings {
  const defaults = defaultRoutingSettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const record = value as Record<string, unknown>;
  const field = <K extends keyof typeof routingScalarShape>(key: K): RoutingSettings[K] => {
    const parsed = routingScalarShape[key].safeParse(record[key]);
    return (parsed.success ? parsed.data : defaults[key]) as RoutingSettings[K];
  };
  const tiersRecord = record.tiers && typeof record.tiers === "object" && !Array.isArray(record.tiers)
    ? record.tiers as Record<string, unknown>
    : {};
  const tiers = Object.fromEntries(ROUTING_TIERS.map((tier) => {
    const parsed = routingTierSettingsSchema.safeParse(tiersRecord[tier]);
    return [tier, parsed.success ? cloneTier(parsed.data) : { presets: null }];
  })) as RoutingSettings["tiers"];
  return {
    enabled: field("enabled"),
    autoForNewChats: field("autoForNewChats"),
    picker: field("picker"),
    confidenceThreshold: field("confidenceThreshold"),
    fallbackTier: field("fallbackTier"),
    stickiness: field("stickiness"),
    quotaReservePercent: field("quotaReservePercent"),
    tiers,
  };
}

export function parseRoutingSettingsJson(value: unknown): RoutingSettings {
  if (typeof value !== "string" || value.length > ROUTING_SETTINGS_JSON_MAX_LENGTH) {
    return defaultRoutingSettings();
  }
  try {
    return parseRoutingSettings(JSON.parse(value));
  } catch {
    return defaultRoutingSettings();
  }
}

export function mergeRoutingSettings(
  current: RoutingSettings,
  update: RoutingSettingsUpdate | undefined,
): RoutingSettings {
  if (!update) return parseRoutingSettings(current);
  const { tiers, ...scalars } = update;
  return parseRoutingSettings({
    ...current,
    ...scalars,
    tiers: { ...current.tiers, ...tiers },
  });
}

export function serializeRoutingSettings(settings: RoutingSettings): string {
  const json = JSON.stringify(routingSettingsSchema.parse(settings));
  if (json.length > ROUTING_SETTINGS_JSON_MAX_LENGTH) {
    throw new Error("Routing settings are too large.");
  }
  return json;
}

export function boundedRoutingReason(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= ROUTING_REASON_MAX_LENGTH
    ? compact
    : `${compact.slice(0, ROUTING_REASON_MAX_LENGTH - 1).trimEnd()}…`;
}

export function parseRoutingDecisionJson(value: unknown): RoutingDecisionSummary | null {
  if (typeof value !== "string" || value.length > ROUTING_DECISION_JSON_MAX_LENGTH) return null;
  try {
    const parsed = routingDecisionSummarySchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The bounded, schema-valid form of a decision, or null. A previous route that
 * does not fit the schema is dropped rather than failing the turn that carries it.
 */
export function safeRoutingDecisionSummary(value: unknown): RoutingDecisionSummary | null {
  let parsed = routingDecisionSummarySchema.safeParse(value);
  if (!parsed.success && value && typeof value === "object" && "previousRoute" in value) {
    parsed = routingDecisionSummarySchema.safeParse({ ...value, previousRoute: null });
  }
  if (!parsed.success) return null;
  return JSON.stringify(parsed.data).length <= ROUTING_DECISION_JSON_MAX_LENGTH ? parsed.data : null;
}

export function serializeRoutingDecision(summary: RoutingDecisionSummary): string {
  const json = JSON.stringify(routingDecisionSummarySchema.parse(summary));
  if (json.length > ROUTING_DECISION_JSON_MAX_LENGTH) {
    throw new Error("The routing decision is too large.");
  }
  return json;
}

/** The persisted mode a newly created chat receives when its creator did not choose one. */
export function newChatRoutingMode(routing: Pick<RoutingSettings, "enabled" | "autoForNewChats">): RoutingMode {
  return routing.enabled && routing.autoForNewChats ? "auto" : "manual";
}
