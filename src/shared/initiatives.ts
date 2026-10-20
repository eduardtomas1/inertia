import { z } from "zod";

import { PROJECT_COLOR_NAMES, type ProjectColorName } from "./project-colors";

/**
 * An Initiative is a named group of chats across any projects, including chats
 * without a project. Membership is a single nullable reference on the chat and
 * never changes a chat's project, workspace, worktree, provider or session.
 */
export const MAX_INITIATIVES = 100;
/** Counted in Unicode code points, as SQLite `length()` counts characters. */
export const MAX_INITIATIVE_NAME_CHARS = 120;
/**
 * Reserved for the initiative brief; persisted now so later phases need no
 * column change. Counted in UTF-8 bytes in both zod and the SQL CHECK
 * (`length(CAST(brief AS BLOB))`), because later phases budget prompt bytes.
 */
export const MAX_INITIATIVE_BRIEF_BYTES = 8_192;

export const INITIATIVE_STATUSES = ["active", "done", "archived"] as const;
/** Initiative colours reuse the theme-aware project palette names. */
export const INITIATIVE_COLORS = PROJECT_COLOR_NAMES;

export type InitiativeStatus = typeof INITIATIVE_STATUSES[number];
export type InitiativeColor = ProjectColorName;

const timestampSchema = z.string().datetime({ offset: true });

export const initiativeStatusSchema = z.enum(INITIATIVE_STATUSES);
export const initiativeColorSchema = z.enum(INITIATIVE_COLORS);

export const INITIATIVE_STATUS_LABELS: Readonly<Record<InitiativeStatus, string>> = {
  active: "Active",
  done: "Done",
  archived: "Archived",
};

/*
 * Stored names follow exactly the SQL CHECK on `initiatives.name`, so a row the
 * database accepts always parses: 1..120 code points, no NUL, tab, CR or LF,
 * and no leading or trailing space (SQLite `trim()` strips only spaces).
 */
const INITIATIVE_NAME_FORBIDDEN = /[\0\t\n\r]/u;

function storedInitiativeName(value: string): boolean {
  const length = [...value].length;
  return length >= 1
    && length <= MAX_INITIATIVE_NAME_CHARS
    && !INITIATIVE_NAME_FORBIDDEN.test(value)
    && !value.startsWith(" ")
    && !value.endsWith(" ");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** A name as stored; mirrors the SQL CHECK and never transforms. */
export const initiativeNameSchema = z.string().refine(
  storedInitiativeName,
  "Initiative names need 1 to 120 characters on one line, without tabs.",
);

/** A name as typed: surrounding whitespace is dropped, then the stored rule applies. */
export const initiativeNameInputSchema = z.string().trim().pipe(initiativeNameSchema);

/** A brief as stored; mirrors the SQL CHECK, counting UTF-8 bytes. */
export const initiativeBriefSchema = z.string()
  .refine((value) => !value.includes("\0"), "Initiative briefs cannot contain NUL bytes.")
  .refine(
    (value) => utf8ByteLength(value) <= MAX_INITIATIVE_BRIEF_BYTES,
    `Initiative briefs are limited to ${MAX_INITIATIVE_BRIEF_BYTES} bytes.`,
  );

export const initiativeSchema = z.object({
  id: z.string().uuid(),
  name: initiativeNameSchema,
  color: initiativeColorSchema,
  status: initiativeStatusSchema,
  brief: initiativeBriefSchema,
  briefRevision: z.number().int().min(0),
  // The SQL column allows 0 (its default); new rows start at 1.
  revision: z.number().int().min(0),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const initiativePatchSchema = z.object({
  name: initiativeNameInputSchema.optional(),
  color: initiativeColorSchema.optional(),
  status: initiativeStatusSchema.optional(),
}).strict().refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  "An initiative update must change at least one field.",
);

export type Initiative = z.infer<typeof initiativeSchema>;
export type InitiativePatch = z.infer<typeof initiativePatchSchema>;

/** True for a name that is ready to submit: valid as stored and already trimmed. */
export function isInitiativeName(value: unknown): value is string {
  return typeof value === "string"
    && value === value.trim()
    && initiativeNameSchema.safeParse(value).success;
}

export function isInitiativeColor(value: unknown): value is InitiativeColor {
  return typeof value === "string" && (INITIATIVE_COLORS as readonly string[]).includes(value);
}

/** Rotates through the palette so consecutive initiatives stay distinguishable. */
export function defaultInitiativeColor(existingCount: number): InitiativeColor {
  const index = Number.isSafeInteger(existingCount) && existingCount > 0 ? existingCount : 0;
  return INITIATIVE_COLORS[index % INITIATIVE_COLORS.length];
}

/** Stable display order: creation time, then identity. */
export function compareInitiatives(
  left: Pick<Initiative, "createdAt" | "id">,
  right: Pick<Initiative, "createdAt" | "id">,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** True when new chats may join this initiative. */
export function initiativeAcceptsChats(initiative: Pick<Initiative, "status">): boolean {
  return initiative.status === "active";
}

/**
 * Groups items by the initiative they belong to, keeping input order. The one
 * membership grouping shared by the sidebar sections, the Initiatives page and
 * the command palette; callers filter first (archived chats, placement).
 */
export function initiativeMembers<T>(
  items: Iterable<T>,
  initiativeIdOf: (item: T) => string | null | undefined,
): Map<string, T[]> {
  const members = new Map<string, T[]>();
  for (const item of items) {
    const initiativeId = initiativeIdOf(item);
    if (!initiativeId) continue;
    const list = members.get(initiativeId);
    if (list) list.push(item);
    else members.set(initiativeId, [item]);
  }
  return members;
}
