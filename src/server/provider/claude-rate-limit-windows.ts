import type { ProviderRateLimit } from "../../shared/contracts";

const WEEK_MINUTES = 10_080;
const MODEL_WEEKLY_PREFIX = "Weekly · ";
const LEGACY_MODEL_ID = /^claude:model_(\d+)$/u;
const MODEL_SCOPED_ID_PREFIX = "claude:model_scoped:";

export const CLAUDE_MODEL_WEEKLY_LIMIT_ID = "claude:seven_day_overage_included";
const UNNAMED_MODEL = "model";
const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"];

const WINDOWS: Readonly<Record<string, { label: string; minutes: number | null }>> = {
  five_hour: { label: "Session", minutes: 300 },
  seven_day: { label: "Weekly", minutes: WEEK_MINUTES },
  seven_day_oauth_apps: { label: "Weekly · Apps", minutes: WEEK_MINUTES },
  seven_day_opus: { label: "Weekly · Opus", minutes: WEEK_MINUTES },
  seven_day_sonnet: { label: "Weekly · Sonnet", minutes: WEEK_MINUTES },
  overage: { label: "Extra usage", minutes: null },
};

function modelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replaceAll("\0", "").trim().slice(0, 80);
  return clean || null;
}

function modelSlug(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "");
}

function claudeModelWeeklyLabel(model?: unknown): string {
  return `${MODEL_WEEKLY_PREFIX}${modelName(model) ?? UNNAMED_MODEL}`;
}

export function claudeRateLimitWindow(type: string): { label: string; minutes: number | null } {
  if (type === "seven_day_overage_included") {
    return { label: claudeModelWeeklyLabel(), minutes: WEEK_MINUTES };
  }
  const known = WINDOWS[type];
  if (known) return known;
  const words = type.replaceAll("_", " ").trim();
  return {
    label: words ? `${words.slice(0, 1).toUpperCase()}${words.slice(1)}` : "Claude limit",
    minutes: null,
  };
}

export function claudeModelScopedWindows(
  entries: readonly unknown[],
): Array<{ id: string; label: string; value: Record<string, unknown> }> {
  const models = entries.slice(0, 8).flatMap((entry) => (
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? [entry as Record<string, unknown>]
      : []
  ));
  return models.map((value, index) => {
    const name = modelName(value.display_name);
    return {
      id: index === 0
        ? CLAUDE_MODEL_WEEKLY_LIMIT_ID
        : `${MODEL_SCOPED_ID_PREFIX}${(name && modelSlug(name)) || index}`,
      label: claudeModelWeeklyLabel(name ?? `model ${index + 1}`),
      value,
    };
  });
}

function isModelWeeklyWindow(id: string): boolean {
  return id === CLAUDE_MODEL_WEEKLY_LIMIT_ID || id.startsWith(MODEL_SCOPED_ID_PREFIX);
}

function modelWeeklyScope(window: { id: string; label: string }): string | null {
  if (!window.label.startsWith(MODEL_WEEKLY_PREFIX)) return null;
  const scope = modelSlug(window.label.slice(MODEL_WEEKLY_PREFIX.length));
  return scope && scope !== UNNAMED_MODEL ? scope : null;
}

type ClaudeModelWeeklyRelation = "applies" | "other-model" | "unknown";

export function claudeModelWeeklyRelation(
  window: { id: string; label: string },
  modelNames: readonly (string | null | undefined)[],
): ClaudeModelWeeklyRelation | null {
  if (!isModelWeeklyWindow(window.id)) return null;
  const scope = modelWeeklyScope(window);
  const names = modelNames.flatMap((name) => name ? [modelSlug(name)] : []);
  if (scope && names.some((name) => name.includes(scope))) return "applies";
  const families = CLAUDE_FAMILIES.filter((family) => names.some((name) => name.split("-").includes(family)));
  return scope && CLAUDE_FAMILIES.includes(scope) && families.length > 0 && !families.includes(scope)
    ? "other-model"
    : "unknown";
}

export function withKnownClaudeModelWeeklyLabel<T extends { id: string; label: string }>(
  previous: readonly T[],
  next: readonly T[],
): T[] {
  const known = previous.find(({ id }) => id === CLAUDE_MODEL_WEEKLY_LIMIT_ID);
  if (!known?.label.startsWith(MODEL_WEEKLY_PREFIX)) return [...next];
  const fallback = claudeModelWeeklyLabel();
  return next.map((limit) => (
    limit.id === CLAUDE_MODEL_WEEKLY_LIMIT_ID && limit.label === fallback
      ? { ...limit, label: known.label }
      : limit
  ));
}

export function canonicalClaudeRateLimits(
  limits: readonly ProviderRateLimit[],
): ProviderRateLimit[] {
  const live = limits.find(({ id }) => id === CLAUDE_MODEL_WEEKLY_LIMIT_ID);
  const legacy = limits.filter(({ id }) => LEGACY_MODEL_ID.test(id));
  const scopedName = (limit: ProviderRateLimit): string => (
    limit.label.startsWith(MODEL_WEEKLY_PREFIX)
      ? limit.label
      : claudeModelWeeklyLabel(limit.label)
  );
  const primary = legacy.find(({ id }) => id === "claude:model_0");
  const result: ProviderRateLimit[] = [];
  for (const limit of limits) {
    if (!limit.id.startsWith("claude:")) {
      result.push(limit);
      continue;
    }
    if (limit === primary) {
      if (!live) result.push({ ...limit, id: CLAUDE_MODEL_WEEKLY_LIMIT_ID, label: scopedName(limit) });
      continue;
    }
    if (LEGACY_MODEL_ID.test(limit.id)) {
      result.push({
        ...limit,
        id: `${MODEL_SCOPED_ID_PREFIX}${modelSlug(limit.label) || limit.id.slice("claude:model_".length)}`,
        label: scopedName(limit),
      });
      continue;
    }
    if (limit.id === CLAUDE_MODEL_WEEKLY_LIMIT_ID) {
      result.push({
        ...limit,
        label: limit.label.startsWith(MODEL_WEEKLY_PREFIX)
          ? limit.label
          : primary ? scopedName(primary) : claudeModelWeeklyLabel(),
        windowMinutes: limit.windowMinutes ?? WEEK_MINUTES,
      });
      continue;
    }
    if (limit.id.startsWith(MODEL_SCOPED_ID_PREFIX)) {
      result.push(limit);
      continue;
    }
    const known = WINDOWS[limit.id.slice("claude:".length)];
    result.push(known ? { ...limit, label: known.label } : limit);
  }
  return result;
}
