import type { ProviderRateLimit } from "../../shared/contracts";

const WEEK_MINUTES = 10_080;
const MODEL_WEEKLY_PREFIX = "Weekly · ";
const LEGACY_MODEL_ID = /^claude:model_(\d+)$/u;
const MODEL_SCOPED_ID_PREFIX = "claude:model_scoped:";

export const CLAUDE_MODEL_WEEKLY_LIMIT_ID = "claude:seven_day_overage_included";
export const CLAUDE_MODEL_WEEKLY_DEFAULT_MODEL = "Fable";

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

export function claudeModelWeeklyLabel(model?: unknown): string {
  return `${MODEL_WEEKLY_PREFIX}${modelName(model) ?? CLAUDE_MODEL_WEEKLY_DEFAULT_MODEL}`;
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
  const named = models.map((value) => modelName(value.display_name));
  const defaultIndex = named.findIndex((name) => (
    name?.toLowerCase() === CLAUDE_MODEL_WEEKLY_DEFAULT_MODEL.toLowerCase()
  ));
  const liveIndex = models.length === 1 ? 0 : defaultIndex;
  return models.map((value, index) => {
    const name = named[index] ?? null;
    return {
      id: index === liveIndex
        ? CLAUDE_MODEL_WEEKLY_LIMIT_ID
        : `${MODEL_SCOPED_ID_PREFIX}${(name && modelSlug(name)) || index}`,
      label: claudeModelWeeklyLabel(name ?? `model ${index + 1}`),
      value,
    };
  });
}

export function claudeModelWeeklyScope(window: { id: string; label: string }): string | null {
  if (
    window.id !== CLAUDE_MODEL_WEEKLY_LIMIT_ID
    && !window.id.startsWith(MODEL_SCOPED_ID_PREFIX)
  ) return null;
  if (!window.label.startsWith(MODEL_WEEKLY_PREFIX)) return null;
  return modelSlug(window.label.slice(MODEL_WEEKLY_PREFIX.length)) || null;
}

export function claudeModelWeeklyAppliesTo(
  window: { id: string; label: string },
  model: string,
): boolean {
  const scope = claudeModelWeeklyScope(window);
  return scope !== null && modelSlug(model).includes(scope);
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
  const primary = legacy.length === 1
    ? legacy[0]!
    : legacy.find(({ label }) => (
      label.toLowerCase() === CLAUDE_MODEL_WEEKLY_DEFAULT_MODEL.toLowerCase()
    ));
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
