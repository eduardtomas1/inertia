import {
  isLiveMascotPhase, isMascotFocus, MASCOT_CHAT_LIMIT, parseMascotChats, parseMascotStatus,
  type MascotCounts, type MascotPhase, type MascotStatus,
} from "./mascot";

export interface MascotFeed {
  status: MascotStatus;
  chats: MascotStatus[];
  focus: string | null;
  counts: MascotCounts | null;
  request?: number | null;
}

export type MascotFeedInvariant =
  | "list within cap"
  | "unique chat ids"
  | "rows share the active count"
  | "status is never unavailable"
  | "status leads the list"
  | "idle status means nothing is active"
  | "active chats put an active status first"
  | "listed chats that need you put such a status first"
  | "active count covers active rows"
  | "rows are ranked by urgency"
  | "top rows hold the active chats"
  | "focus is listed"
  | "focus answers a request"
  | "attention within active"
  | "active within chats"
  | "list length matches the total"
  | "attention covers attention rows"
  | "top rows hold the chats that need you"
  | "status needs you exactly when a chat does";

export function isMascotRequest(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
}

function isMascotCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
}

export function parseMascotCounts(value: unknown): MascotCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return null;
  const { chats, attention } = value as Record<string, unknown>;
  return isMascotCount(chats) && isMascotCount(attention) ? { chats, attention } : null;
}

function needsYou(phase: MascotPhase): boolean {
  return phase === "waiting-for-input" || phase === "waiting-for-approval";
}

function urgency(phase: MascotPhase): number {
  return needsYou(phase) ? 2 : isLiveMascotPhase(phase) ? 1 : 0;
}

export function mascotFeedViolation({ status, chats, focus, counts, request }: MascotFeed): MascotFeedInvariant | null {
  const active = status.activeCount;
  const activeRows = chats.filter(({ phase }) => isLiveMascotPhase(phase)).length;
  const attentionRows = chats.filter(({ phase }) => needsYou(phase)).length;
  const ids = new Set(chats.map(({ conversationId }) => conversationId));
  const spliced = focus !== null && chats.at(-1)?.conversationId === focus ? 1 : 0;
  const ranked = chats.slice(0, chats.length - spliced);
  const identity = ["projectId", "conversationId", "runId", "turnId", "phase"] as const;
  const checks: Array<[MascotFeedInvariant, boolean]> = [
    ["list within cap", chats.length <= MASCOT_CHAT_LIMIT],
    ["unique chat ids", ids.size === chats.length && !ids.has(null)],
    ["rows share the active count", chats.every((chat) => chat.activeCount === active)],
    ["status is never unavailable", status.phase !== "unavailable"],
    ["status leads the list", status.conversationId === null || identity.every((key) => chats[0]?.[key] === status[key])],
    ["idle status means nothing is active", status.conversationId !== null || (active === 0 && (counts?.attention ?? 0) === 0)],
    ["active chats put an active status first", active === 0 || isLiveMascotPhase(status.phase)],
    ["listed chats that need you put such a status first", attentionRows === 0 || needsYou(status.phase)],
    ["active count covers active rows", active >= activeRows],
    ["rows are ranked by urgency", ranked.every((chat, index) => index === 0 || urgency(ranked[index - 1]!.phase) >= urgency(chat.phase))],
    ["top rows hold the active chats", activeRows >= Math.min(active, chats.length) - spliced],
    ["focus is listed", focus === null || ids.has(focus)],
    ["focus answers a request", focus === null || request !== null],
  ];
  if (counts) checks.push(
    ["attention within active", counts.attention <= active],
    ["active within chats", active <= counts.chats],
    ["list length matches the total", chats.length === Math.min(counts.chats, MASCOT_CHAT_LIMIT)],
    ["attention covers attention rows", counts.attention >= attentionRows],
    ["top rows hold the chats that need you", attentionRows >= Math.min(counts.attention, chats.length) - spliced],
    ["status needs you exactly when a chat does", needsYou(status.phase) === (counts.attention > 0)],
  );
  return checks.find(([, holds]) => !holds)?.[0] ?? null;
}

export function parseMascotFeed(value: Record<string, unknown>): MascotFeed | null {
  const status = parseMascotStatus(value.status);
  const chats = parseMascotChats(value.chats);
  const hasCounts = Object.hasOwn(value, "counts");
  const hasRequest = Object.hasOwn(value, "request");
  const counts = hasCounts ? parseMascotCounts(value.counts) : null;
  const { focus, request } = value;
  if (!status || !chats || (hasCounts && !counts) || !isMascotFocus(focus)) return null;
  if (hasRequest && request !== null && !isMascotRequest(request)) return null;
  const feed: MascotFeed = { status, chats, focus, counts, ...(hasRequest ? { request: request as number | null } : {}) };
  return mascotFeedViolation(feed) ? null : feed;
}
