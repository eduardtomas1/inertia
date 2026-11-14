interface UsageWindowTitleInput {
  id: string;
  label: string;
  windowMinutes: number | null;
}

const SESSION_MINUTES = 300;
const WEEK_MINUTES = 10_080;
const SLOT_SUFFIX = /:(?:primary|secondary)$/u;
const SECONDARY_LABEL = / · secondary$/u;

export function usageWindowDurationTitle(windowMinutes: number | null): string | null {
  if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  if (windowMinutes === SESSION_MINUTES) return "Session";
  if (windowMinutes === WEEK_MINUTES) return "Weekly";
  if (windowMinutes % 1_440 === 0) {
    const days = windowMinutes / 1_440;
    return days === 1 ? "Daily" : `${days}-day window`;
  }
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour window`;
  return `${windowMinutes}-minute window`;
}

export function usageWindowTitle(window: UsageWindowTitleInput): string {
  if (!SLOT_SUFFIX.test(window.id)) return window.label;
  const duration = usageWindowDurationTitle(window.windowMinutes);
  const name = window.label.replace(SECONDARY_LABEL, "").trim();
  if (window.id.startsWith("codex:")) return duration ?? (name || window.label);
  if (!duration) return window.label;
  return name ? `${name} · ${duration}` : duration;
}

const DURATION_TITLE = /^(?:Session|Weekly|Daily|\d+-(?:hour|day|minute) window)$/u;

export function usageLimitName(window: UsageWindowTitleInput): string {
  const title = usageWindowTitle(window);
  if (/limit$/iu.test(title)) return title;
  const [head, ...rest] = title.split(" · ");
  if (rest.length > 0 && DURATION_TITLE.test(head!)) {
    return [`${head!.replace(/ window$/u, "")} limit`, ...rest].join(" · ");
  }
  return `${title.replace(/ window$/u, "")} limit`;
}
