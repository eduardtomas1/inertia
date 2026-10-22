import { INTERFACE_LOCALE } from "../lib/locale";

export type TodoDuePreset = "today" | "tomorrow" | "next-week";

export const TODO_DUE_PRESETS: readonly TodoDuePreset[] = ["today", "tomorrow", "next-week"];

export const TODO_DUE_PRESET_LABELS: Readonly<Record<TodoDuePreset, string>> = {
  today: "Today",
  tomorrow: "Tomorrow",
  "next-week": "Next week",
};

export interface TodoDueLabel {
  text: string;
  overdue: boolean;
  today: boolean;
}

interface TodoDue {
  dueDate: string | null;
  dueTime: string | null;
}

const DAY_MS = 86_400_000;

const timeFormatter = new Intl.DateTimeFormat(INTERFACE_LOCALE, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function splitTime(value: string): [number, number] {
  const [hours, minutes] = value.split(":").map(Number);
  return [hours!, minutes!];
}

export function parseLocalDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDaysToDateKey(value: string, days: number): string {
  return localDateKey(addLocalDays(parseLocalDateKey(value), days));
}

export function addMonthsToDateKey(value: string, months: number): string {
  const date = parseLocalDateKey(value);
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return localDateKey(new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay)));
}

export function todoCalendarDaysBetween(from: Date, to: Date): number {
  return Math.round((startOfLocalDay(to).getTime() - startOfLocalDay(from).getTime()) / DAY_MS);
}

export function todoDuePresetDate(preset: TodoDuePreset, now = new Date()): string {
  const today = startOfLocalDay(now);
  if (preset === "today") return localDateKey(today);
  if (preset === "tomorrow") return localDateKey(addLocalDays(today, 1));
  const untilMonday = (8 - today.getDay()) % 7 || 7;
  return localDateKey(addLocalDays(today, untilMonday === 1 ? 8 : untilMonday));
}

export function todoWeekStart(locale?: string): number {
  const tag = locale ?? (typeof navigator === "undefined" ? undefined : navigator.language);
  if (!tag) return 1;
  try {
    const info = new Intl.Locale(tag).maximize() as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    return typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7 ? firstDay % 7 : 1;
  } catch {
    return 1;
  }
}

export function todoDueInstant(due: { dueDate: string; dueTime: string | null }): Date {
  const day = parseLocalDateKey(due.dueDate);
  if (!due.dueTime) return day;
  const [hours, minutes] = splitTime(due.dueTime);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
}

export function todoIsOverdue(due: TodoDue, now = new Date()): boolean {
  if (!due.dueDate) return false;
  const days = todoCalendarDaysBetween(now, parseLocalDateKey(due.dueDate));
  if (days !== 0) return days < 0;
  return due.dueTime !== null && todoDueInstant({ dueDate: due.dueDate, dueTime: due.dueTime }).getTime() < now.getTime();
}

export function formatTodoTime(value: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(value)) return value;
  const [hours, minutes] = splitTime(value);
  return timeFormatter.format(Date.UTC(2000, 0, 1, hours, minutes));
}

export function formatTodoDay(value: string): string {
  const date = parseLocalDateKey(value);
  const weekday = date.toLocaleDateString(INTERFACE_LOCALE, { weekday: "short" });
  const month = date.toLocaleDateString(INTERFACE_LOCALE, { month: "short" });
  return `${weekday} ${date.getDate()} ${month}`;
}

export function formatTodoDayLong(value: string): string {
  const date = parseLocalDateKey(value);
  const weekday = date.toLocaleDateString(INTERFACE_LOCALE, { weekday: "long" });
  const month = date.toLocaleDateString(INTERFACE_LOCALE, { month: "long" });
  return `${weekday} ${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function todoDueLabel(due: TodoDue, now = new Date()): TodoDueLabel | null {
  if (!due.dueDate) return null;
  const date = parseLocalDateKey(due.dueDate);
  const days = todoCalendarDaysBetween(now, date);
  const overdue = todoIsOverdue(due, now);
  if (days < 0) return { text: `Overdue · ${-days} d`, overdue, today: false };
  let text: string;
  if (days === 0) text = "Today";
  else if (days === 1) text = "Tomorrow";
  else if (days < 7) text = date.toLocaleDateString(INTERFACE_LOCALE, { weekday: "short" });
  else {
    const month = date.toLocaleDateString(INTERFACE_LOCALE, { month: "short" });
    text = `${date.getDate()} ${month}`;
    if (date.getFullYear() !== now.getFullYear()) text = `${text} ${date.getFullYear()}`;
  }
  if (due.dueTime) text = `${text} ${formatTodoTime(due.dueTime)}`;
  return { text, overdue, today: days === 0 };
}

export function parseTodoTime(input: string): string | null {
  let value = input.trim().toLowerCase().replace(/[\s  ]+/gu, " ");
  if (!value) return null;
  let meridiem: "am" | "pm" | null = null;
  const suffix = /^(.*?) ?([ap])\.? ?(?:m\.?)?$/u.exec(value);
  if (suffix) {
    value = suffix[1]!;
    meridiem = suffix[2] === "a" ? "am" : "pm";
  }
  value = value.replace(/h$/u, "");
  let hours: number;
  let minutes: number;
  const separated = /^(\d{1,2})(?:[:.h](\d{2}))?$/u.exec(value);
  const compact = /^(\d{1,2})(\d{2})$/u.exec(value);
  if (separated) {
    hours = Number(separated[1]);
    minutes = separated[2] === undefined ? 0 : Number(separated[2]);
  } else if (compact) {
    hours = Number(compact[1]);
    minutes = Number(compact[2]);
  } else {
    return null;
  }
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return `${pad(hours)}:${pad(minutes)}`;
}
