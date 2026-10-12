import { INTERFACE_LOCALE } from "../lib/locale";

export type TodoDuePreset = "today" | "tomorrow" | "next-week";

const DAY_MS = 86_400_000;

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function parseDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function localDateKey(date: Date): string {
  const part = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

export function todoDuePresetDate(preset: TodoDuePreset, now = new Date()): string {
  const today = startOfLocalDay(now);
  if (preset === "today") return localDateKey(today);
  if (preset === "tomorrow") return localDateKey(addLocalDays(today, 1));
  return localDateKey(addLocalDays(today, (8 - today.getDay()) % 7 || 7));
}

export function todoDueLabel(dueDate: string, now = new Date()): string {
  const due = parseDateKey(dueDate);
  const today = startOfLocalDay(now);
  const days = Math.round((due.getTime() - today.getTime()) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days < 7) {
    return due.toLocaleDateString(INTERFACE_LOCALE, { weekday: "short" });
  }
  const month = due.toLocaleDateString(INTERFACE_LOCALE, { month: "short" });
  const label = `${due.getDate()} ${month}`;
  return due.getFullYear() === today.getFullYear() ? label : `${label} ${due.getFullYear()}`;
}
