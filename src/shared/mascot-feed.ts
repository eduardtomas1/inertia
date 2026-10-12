import {
  isLiveMascotPhase, isMascotAttention, isMascotFocus, MASCOT_CHAT_LIMIT, MASCOT_ROW_LIMIT, mascotTier, parseMascotChats,
  parseMascotStatus, type MascotCounts, type MascotStatus,
} from "./mascot";

export interface MascotFeed {
  status: MascotStatus;
  chats: MascotStatus[];
  rows: MascotStatus[];
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
  | "idle status means nothing to show"
  | "active count covers active rows"
  | "focus is listed"
  | "focus answers a request"
  | "row list within cap"
  | "unique row ids"
  | "rows leave out the shown chat"
  | "rows hold only chats to show"
  | "rows are ranked by urgency"
  | "status outranks the rows"
  | "attention within active"
  | "active within chats"
  | "others within chats"
  | "list length matches the total"
  | "row count matches the others"
  | "attention covers the rows that need you"
  | "top rows hold the chats that need you"
  | "status needs you exactly when a chat does";

export function isMascotRequest(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
}

function isMascotCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
}

export function parseMascotCounts(value: unknown): MascotCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) return null;
  const { chats, attention, others } = value as Record<string, unknown>;
  return isMascotCount(chats) && isMascotCount(attention) && isMascotCount(others) ? { chats, attention, others } : null;
}

export function mascotFeedViolation({ status, chats, rows, focus, counts, request }: MascotFeed): MascotFeedInvariant | null {
  const active = status.activeCount;
  const ids = new Set(chats.map(({ conversationId }) => conversationId));
  const rowIds = new Set(rows.map(({ conversationId }) => conversationId));
  const shown = focus ?? status.conversationId;
  const shownPhase = focus === null ? status.phase : chats.find(({ conversationId }) => conversationId === focus)?.phase ?? "idle";
  const live = new Set([status, ...chats, ...rows].filter(({ phase }) => isLiveMascotPhase(phase)).map(({ conversationId }) => conversationId));
  const attentionIds = new Set([status, ...rows].filter(({ phase }) => isMascotAttention(phase)).map(({ conversationId }) => conversationId));
  const rowsNeedingYou = rows.filter(({ phase }) => isMascotAttention(phase)).length;
  const identity = ["projectId", "conversationId", "runId", "turnId", "phase"] as const;
  const checks: Array<[MascotFeedInvariant, boolean]> = [
    ["list within cap", chats.length <= MASCOT_CHAT_LIMIT],
    ["unique chat ids", ids.size === chats.length && !ids.has(null)],
    ["rows share the active count", [...chats, ...rows].every((chat) => chat.activeCount === active)],
    ["status is never unavailable", status.phase !== "unavailable"],
    ["status leads the list", status.conversationId === null || identity.every((key) => chats[0]?.[key] === status[key])],
    ["idle status means nothing to show", status.conversationId !== null
      || (!rows.length && (counts?.attention ?? 0) === 0 && (counts?.others ?? 0) === 0)],
    ["active count covers active rows", active >= live.size - Number(live.has(null))],
    ["focus is listed", focus === null || ids.has(focus)],
    ["focus answers a request", focus === null || request !== null],
    ["row list within cap", rows.length <= MASCOT_ROW_LIMIT],
    ["unique row ids", rowIds.size === rows.length && !rowIds.has(null)],
    ["rows leave out the shown chat", shown === null || !rowIds.has(shown)],
    ["rows hold only chats to show", rows.every(({ phase }) => mascotTier(phase) > 0)],
    ["rows are ranked by urgency", rows.every((row, index) => index === 0 || mascotTier(rows[index - 1]!.phase) >= mascotTier(row.phase))],
    ["status outranks the rows", focus !== null || !rows.length || mascotTier(status.phase) >= mascotTier(rows[0]!.phase)],
  ];
  if (counts) checks.push(
    ["attention within active", counts.attention <= active],
    ["active within chats", active <= counts.chats],
    ["others within chats", counts.others <= counts.chats],
    ["list length matches the total", chats.length === Math.min(counts.chats, MASCOT_CHAT_LIMIT)],
    ["row count matches the others", rows.length === Math.min(counts.others, MASCOT_ROW_LIMIT)],
    ["attention covers the rows that need you", counts.attention >= attentionIds.size],
    ["top rows hold the chats that need you",
      rowsNeedingYou >= Math.min(counts.attention - Number(isMascotAttention(shownPhase)), rows.length)],
    ["status needs you exactly when a chat does", isMascotAttention(status.phase) === (counts.attention > 0)],
  );
  return checks.find(([, holds]) => !holds)?.[0] ?? null;
}

export function parseMascotFeed(value: Record<string, unknown>): MascotFeed | null {
  const status = parseMascotStatus(value.status);
  const chats = parseMascotChats(value.chats);
  const rows = parseMascotChats(value.rows, MASCOT_ROW_LIMIT);
  const hasCounts = Object.hasOwn(value, "counts");
  const hasRequest = Object.hasOwn(value, "request");
  const counts = hasCounts ? parseMascotCounts(value.counts) : null;
  const { focus, request } = value;
  if (!status || !chats || !rows || (hasCounts && !counts) || !isMascotFocus(focus)) return null;
  if (hasRequest && request !== null && !isMascotRequest(request)) return null;
  const feed: MascotFeed = { status, chats, rows, focus, counts, ...(hasRequest ? { request: request as number | null } : {}) };
  return mascotFeedViolation(feed) ? null : feed;
}
