import { z } from "zod";

import { ACCESS_MODES } from "./access-modes";
import { modelSelectionSchema, type ModelSelection } from "./model-routing";
import { PROJECT_COLOR_NAMES, type ProjectColorName } from "./project-colors";
import { isValidClaudeTurnBudgetUsd } from "./claude-turn-budget";
import { INITIATIVE_NOTE_KINDS, type InitiativeNoteKind } from "./initiative-note-proposals";

export {
  INITIATIVE_NOTE_KIND_LABELS,
  INITIATIVE_NOTE_KINDS,
  initiativeNoteProposalReceiptText,
  isInitiativeNoteProposalReceipt,
  type InitiativeNoteKind,
} from "./initiative-note-proposals";

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
/**
 * Accepted notes per initiative. Agent proposals have their own limits below
 * and count here only once the user accepts them; rejected notes never count.
 */
export const MAX_INITIATIVE_NOTES = 64;
/** Agent proposals waiting for the user's review in one initiative. */
export const MAX_PENDING_INITIATIVE_NOTE_PROPOSALS = 16;
/** Agent proposals waiting for review that one chat of an initiative proposed. */
export const MAX_PENDING_INITIATIVE_NOTE_PROPOSALS_PER_CHAT = 5;
/** Rejected notes kept per initiative for their provenance; older ones are pruned. */
export const MAX_REJECTED_INITIATIVE_NOTES = 64;
/** Counted in code points, like initiative names. */
export const MAX_INITIATIVE_NOTE_TITLE_CHARS = 120;
/** Counted in UTF-8 bytes in both zod and the SQL CHECK. */
export const MAX_INITIATIVE_NOTE_BODY_BYTES = 2_048;
/** The notes index shared with agents, in UTF-8 bytes. */
export const MAX_INITIATIVE_NOTES_INDEX_BYTES = 8_192;
/** One index line shows at most this many code points of a note's first line. */
export const MAX_INITIATIVE_NOTE_INDEX_EXCERPT_CHARS = 160;

/** Who wrote a note. Agents can only propose; the user accepts. */
export const NOTE_PROVENANCES = ["user", "agent"] as const;
export const NOTE_STATES = ["proposed", "accepted", "rejected"] as const;
/** Notes one agent turn may propose; further proposals in that turn are refused. */
export const MAX_INITIATIVE_NOTE_PROPOSALS_PER_TURN = 5;

export const INITIATIVE_STATUSES = ["active", "done", "archived"] as const;

/** The refusal for a brief saved over a newer revision; the page recognises it. */
export const INITIATIVE_BRIEF_CONFLICT_MESSAGE = "The brief changed elsewhere. Reload to see the latest.";
/** The refusal for a note saved over a newer revision. */
export const INITIATIVE_NOTE_CONFLICT_MESSAGE = "The note changed elsewhere. Reload to see the latest.";
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
 * Stored names and note titles follow exactly their SQL CHECKs, so a row the
 * database accepts always parses: 1..120 code points, no NUL, tab, CR or LF,
 * and no leading or trailing space (SQLite `trim()` strips only spaces).
 */
const SINGLE_LINE_FORBIDDEN = /[\0\t\n\r]/u;

/*
 * Unicode that would make a note read differently than it is stored. Refused
 * where text enters (the user's commands and the agent tool), never in the
 * stored schemas, so a row the database holds always parses.
 */

/**
 * Bidirectional embedding, override and isolate controls (U+202A–U+202E,
 * U+2066–U+2069): they reorder how the text around them is displayed.
 */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/u;
/** Line and paragraph separators (U+2028, U+2029) break a line without a newline. */
const UNICODE_SEPARATORS = /[\p{Zl}\p{Zp}]/u;
/**
 * Agent titles also refuse C0 and C1 controls and every format character,
 * which covers zero-width spaces and joiners as well as the bidi controls.
 */
const AGENT_TITLE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;
/** Characters that display as nothing, such as zero-width or filler characters. */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

const DIRECTION_CONTROL_MESSAGE = "Remove the text-direction control characters.";
const SEPARATOR_MESSAGE = "Use ordinary line breaks instead of Unicode line or paragraph separators.";

/**
 * Why the user's note title or text cannot be saved as typed, or null. Only
 * the characters that change how a note reads are refused; titles otherwise
 * stay as permissive as the stored rule.
 */
export function initiativeNoteTextProblem(value: string): string | null {
  if (BIDI_CONTROLS.test(value)) return DIRECTION_CONTROL_MESSAGE;
  if (UNICODE_SEPARATORS.test(value)) return SEPARATOR_MESSAGE;
  return null;
}

/**
 * Why an agent's proposed title is refused, or null: one line of visible
 * text, without control, format or separator characters, with at least one
 * letter or digit that is not invisible.
 */
export function agentInitiativeNoteTitleProblem(value: string): string | null {
  if (AGENT_TITLE_FORBIDDEN.test(value)) {
    return "Use one line of plain text without control, invisible formatting, text-direction or separator characters.";
  }
  if (!LETTER_OR_NUMBER.test(value.replace(DEFAULT_IGNORABLE, ""))) {
    return "Use at least one visible letter or digit.";
  }
  return null;
}

/** Why an agent's proposed note text is refused, or null. Other text is neutralised, not refused. */
export function agentInitiativeNoteBodyProblem(value: string): string | null {
  if (value.includes("\0")) return "Remove NUL characters.";
  return initiativeNoteTextProblem(value);
}

function storedSingleLine(value: string, maximum: number): boolean {
  const length = [...value].length;
  return length >= 1
    && length <= maximum
    && !SINGLE_LINE_FORBIDDEN.test(value)
    && !value.startsWith(" ")
    && !value.endsWith(" ");
}

function storedInitiativeName(value: string): boolean {
  return storedSingleLine(value, MAX_INITIATIVE_NAME_CHARS);
}

export function utf8ByteLength(value: string): number {
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

/*
 * Shared tool settings. Every member chat inherits them through the chain
 * initiative → project → Settings; `null` (and `false` for the skills folder)
 * defers to the next layer. Restrictions (the access ceiling, blocking browser
 * tools and the Claude spend limit) apply to every member chat whatever the
 * initiative's status; defaults only matter when a chat is created, which only
 * active initiatives allow.
 */

/** The SQL CHECK on `initiatives.preferences_json`. */
export const MAX_INITIATIVE_PREFERENCES_JSON_CHARS = 65_536;

const accessModeSchema = z.enum(ACCESS_MODES);
const reasoningEffortSchema = z.string().min(1).max(100)
  .refine((value) => value === value.trim() && !/[\0-\u001f\u007f]/u.test(value), "Choose a listed reasoning level.");
const budgetSchema = z.number()
  .refine(isValidClaudeTurnBudgetUsd, "Use an amount from 0.01 to 10,000 USD with at most two decimals.");

const preferenceFields = {
  /**
   * The model for new chats started in this initiative, stored as the
   * canonical selection without its reasoning level. It is validated against
   * the live catalog whenever it is used, so a removed model or a disabled
   * backend falls through to the project and Settings defaults.
   */
  defaultModel: modelSelectionSchema,
  /** The reasoning level for `defaultModel`; ignored without one. */
  defaultReasoningEffort: reasoningEffortSchema,
  defaultAccessMode: accessModeSchema,
  /** No member chat may run with more access than this. */
  accessCeiling: accessModeSchema,
  /** `false` blocks the agent browser tools even where the project allows them. */
  browserAccess: z.boolean(),
  /** Native Claude spend limit per turn; the lower of this and the project's applies. */
  claudeMaxBudgetUsd: budgetSchema,
  /** Pre-fills the project of a chat started from this initiative, while that project exists. */
  defaultProjectId: z.string().uuid(),
} as const;

const storedFields = {
  defaultModel: preferenceFields.defaultModel.nullable().default(null),
  defaultReasoningEffort: preferenceFields.defaultReasoningEffort.nullable().default(null),
  defaultAccessMode: preferenceFields.defaultAccessMode.nullable().default(null),
  accessCeiling: preferenceFields.accessCeiling.nullable().default(null),
  browserAccess: preferenceFields.browserAccess.nullable().default(null),
  claudeMaxBudgetUsd: preferenceFields.claudeMaxBudgetUsd.nullable().default(null),
  defaultProjectId: preferenceFields.defaultProjectId.nullable().default(null),
  /** When on, Inertia keeps a folder of skills that member chats can invoke. */
  skillsFolder: z.boolean().default(false),
};

const fitsPreferencesColumn = (value: unknown): boolean =>
  JSON.stringify(value).length <= MAX_INITIATIVE_PREFERENCES_JSON_CHARS;

/** Stored preferences: every field has a default, so `{}` is the empty preference set. */
export const initiativePreferencesSchema = z.strictObject(storedFields)
  .refine(fitsPreferencesColumn, "Initiative settings are too large.");

/** A change to some preferences; omitted fields keep their value. */
export const initiativePreferencesPatchSchema = z.strictObject({
  defaultModel: preferenceFields.defaultModel.nullable().optional(),
  defaultReasoningEffort: preferenceFields.defaultReasoningEffort.nullable().optional(),
  defaultAccessMode: preferenceFields.defaultAccessMode.nullable().optional(),
  accessCeiling: preferenceFields.accessCeiling.nullable().optional(),
  browserAccess: preferenceFields.browserAccess.nullable().optional(),
  claudeMaxBudgetUsd: preferenceFields.claudeMaxBudgetUsd.nullable().optional(),
  defaultProjectId: preferenceFields.defaultProjectId.nullable().optional(),
  skillsFolder: z.boolean().optional(),
}).refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  "Change at least one initiative setting.",
);

// The default model keeps the shared, readonly `ModelSelection` shape.
export type InitiativePreferences = Omit<z.infer<typeof initiativePreferencesSchema>, "defaultModel"> & {
  defaultModel: ModelSelection | null;
};
export type InitiativePreferencesPatch = Omit<z.infer<typeof initiativePreferencesPatchSchema>, "defaultModel"> & {
  defaultModel?: ModelSelection | null;
};

export function defaultInitiativePreferences(): InitiativePreferences {
  return {
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultAccessMode: null,
    accessCeiling: null,
    browserAccess: null,
    claudeMaxBudgetUsd: null,
    defaultProjectId: null,
    skillsFolder: false,
  };
}

/**
 * Never throws. Valid fields of a damaged or newer record are kept, unknown
 * keys are dropped, and anything unreadable yields the defaults, so a bad row
 * can never block opening an initiative or starting a member chat's turn.
 */
export function parseInitiativePreferences(value: unknown): InitiativePreferences {
  try {
    if (typeof value === "string" && value.length > MAX_INITIATIVE_PREFERENCES_JSON_CHARS) {
      return defaultInitiativePreferences();
    }
    const input: unknown = typeof value === "string" ? JSON.parse(value) : value;
    const parsed = initiativePreferencesSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    if (!input || typeof input !== "object" || Array.isArray(input)) return defaultInitiativePreferences();
    const fieldSchemas: Record<string, z.ZodType> = storedFields;
    const salvaged = initiativePreferencesSchema.safeParse(Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([key, field]) => Object.hasOwn(fieldSchemas, key) && fieldSchemas[key]!.safeParse(field).success),
    ));
    return salvaged.success ? salvaged.data : defaultInitiativePreferences();
  } catch {
    return defaultInitiativePreferences();
  }
}

/** Applies a patch; `defaultReasoningEffort` never outlives `defaultModel`. */
export function applyInitiativePreferencesPatch(
  current: InitiativePreferences,
  patch: InitiativePreferencesPatch,
): InitiativePreferences {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch) as [keyof InitiativePreferences, unknown][]) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  if (next.defaultModel === null) next.defaultReasoningEffort = null;
  return next;
}

// The access ceiling helpers live with the access modes, which every chat
// surface already loads; initiatives re-export them.
export {
  accessModesAboveCeiling,
  clampAccessMode,
  exceedsAccessCeiling,
  initiativeAccessCeilingMessage,
} from "./access-modes";

export type InitiativeSettingSource = "initiative" | "project" | "default";

/**
 * Whether the agent browser tools may run. A `false` at either layer blocks
 * them (the initiative cannot reopen what a project blocks, nor the reverse);
 * otherwise they are allowed. `source` names the layer that decided.
 */
export function effectiveBrowserAccess(
  initiative: Pick<InitiativePreferences, "browserAccess"> | null | undefined,
  project: { browserAccess: boolean | null } | null | undefined,
): { allowed: boolean; source: InitiativeSettingSource } {
  if (initiative?.browserAccess === false) return { allowed: false, source: "initiative" };
  if (project?.browserAccess === false) return { allowed: false, source: "project" };
  if (initiative?.browserAccess === true) return { allowed: true, source: "initiative" };
  if (project?.browserAccess === true) return { allowed: true, source: "project" };
  return { allowed: true, source: "default" };
}

/**
 * The Claude spend limit per turn: the lower of the initiative's and the
 * project's when both are set, either one alone, or none.
 */
export function effectiveClaudeBudget(
  initiative: Pick<InitiativePreferences, "claudeMaxBudgetUsd"> | null | undefined,
  project: { claudeMaxBudgetUsd: number | null } | null | undefined,
): { usd: number | null; source: InitiativeSettingSource } {
  const fromInitiative = initiative?.claudeMaxBudgetUsd ?? null;
  const fromProject = project?.claudeMaxBudgetUsd ?? null;
  if (fromInitiative !== null && (fromProject === null || fromInitiative <= fromProject)) {
    return { usd: fromInitiative, source: "initiative" };
  }
  if (fromProject !== null) return { usd: fromProject, source: "project" };
  return { usd: null, source: "default" };
}

export const initiativeSchema = z.object({
  id: z.string().uuid(),
  name: initiativeNameSchema,
  color: initiativeColorSchema,
  status: initiativeStatusSchema,
  /** Shared tool settings; see `InitiativePreferences`. */
  preferences: initiativePreferencesSchema,
  brief: initiativeBriefSchema,
  briefRevision: z.number().int().min(0),
  /** When the brief last changed; null until it is first edited. */
  briefUpdatedAt: timestampSchema.nullable(),
  /** Moves whenever the set or content of accepted notes changes. */
  notesRevision: z.number().int().min(0),
  /** Agent proposals waiting for the user; they are never shared with agents. */
  proposedNoteCount: z.number().int().min(0).max(MAX_PENDING_INITIATIVE_NOTE_PROPOSALS),
  // The SQL column allows 0 (its default); new rows start at 1.
  revision: z.number().int().min(0),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const initiativePatchSchema = z.object({
  name: initiativeNameInputSchema.optional(),
  color: initiativeColorSchema.optional(),
  status: initiativeStatusSchema.optional(),
  preferences: initiativePreferencesPatchSchema.optional(),
}).strict().refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  "An initiative update must change at least one field.",
);

export type Initiative = Omit<z.infer<typeof initiativeSchema>, "preferences"> & {
  preferences: InitiativePreferences;
};
export type InitiativePatch = Omit<z.infer<typeof initiativePatchSchema>, "preferences"> & {
  preferences?: InitiativePreferencesPatch;
};

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

export type InitiativeNoteProvenance = typeof NOTE_PROVENANCES[number];
export type InitiativeNoteState = typeof NOTE_STATES[number];

export const initiativeNoteProvenanceSchema = z.enum(NOTE_PROVENANCES);
export const initiativeNoteStateSchema = z.enum(NOTE_STATES);

/** A note title as stored; mirrors the SQL CHECK and never transforms. */
export const initiativeNoteTitleSchema = z.string().refine(
  (value) => storedSingleLine(value, MAX_INITIATIVE_NOTE_TITLE_CHARS),
  "Note titles need 1 to 120 characters on one line, without tabs.",
);

/** Refuses, with its own message, the characters `initiativeNoteTextProblem` names. */
function withoutTextProblems<T extends z.ZodType<string>>(schema: T) {
  return schema.superRefine((value, context) => {
    const problem = initiativeNoteTextProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });
}

/**
 * A title as typed: surrounding whitespace is dropped, then the stored rule
 * applies, and text-direction controls and Unicode separators are refused.
 */
export const initiativeNoteTitleInputSchema = withoutTextProblems(
  z.string().trim().pipe(initiativeNoteTitleSchema),
);

/** A note body as stored; mirrors the SQL CHECK, counting UTF-8 bytes. May be empty. */
export const initiativeNoteBodySchema = z.string()
  .refine((value) => !value.includes("\0"), "Notes cannot contain NUL bytes.")
  .refine(
    (value) => utf8ByteLength(value) <= MAX_INITIATIVE_NOTE_BODY_BYTES,
    `Notes are limited to ${MAX_INITIATIVE_NOTE_BODY_BYTES} bytes.`,
  );

/** A note body as typed: the stored rule, without text-direction controls or Unicode separators. */
export const initiativeNoteBodyInputSchema = withoutTextProblems(initiativeNoteBodySchema);

export const initiativeNoteSchema = z.object({
  id: z.string().uuid(),
  initiativeId: z.string().uuid(),
  title: initiativeNoteTitleSchema,
  body: initiativeNoteBodySchema,
  provenance: initiativeNoteProvenanceSchema,
  state: initiativeNoteStateSchema,
  /** The chat an agent proposed it from; null for user notes or once that chat is deleted. */
  sourceConversationId: z.string().min(1).max(200).nullable(),
  /** What an agent said its proposal records; null for user notes and unlabelled proposals. */
  kind: z.enum(INITIATIVE_NOTE_KINDS).nullable(),
  revision: z.number().int().min(0),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().refine(
  ({ provenance, kind }) => provenance === "agent" || kind === null,
  "Only an agent's proposal records a kind.",
);

export type InitiativeNote = z.infer<typeof initiativeNoteSchema>;

const MAX_NOTES_BY_STATE: Readonly<Record<InitiativeNoteState, number>> = {
  accepted: MAX_INITIATIVE_NOTES,
  proposed: MAX_PENDING_INITIATIVE_NOTE_PROPOSALS,
  rejected: MAX_REJECTED_INITIATIVE_NOTES,
};

/**
 * A notes read result: one initiative's notes, each unique, within the bounds
 * the store keeps (accepted notes, proposals waiting for review, and the
 * rejected ones kept for their provenance).
 */
export function isInitiativeNotesResult(value: Record<string, unknown>): boolean {
  const { initiativeId, notes } = value;
  if (
    typeof initiativeId !== "string"
    || !Array.isArray(notes)
    || notes.length > MAX_INITIATIVE_NOTES + MAX_PENDING_INITIATIVE_NOTE_PROPOSALS + MAX_REJECTED_INITIATIVE_NOTES
  ) return false;
  const ids = new Set<string>();
  const counts: Record<InitiativeNoteState, number> = { accepted: 0, proposed: 0, rejected: 0 };
  for (const entry of notes as unknown[]) {
    const parsed = initiativeNoteSchema.safeParse(entry);
    if (!parsed.success || parsed.data.initiativeId !== initiativeId) return false;
    counts[parsed.data.state] += 1;
    ids.add(parsed.data.id);
  }
  return ids.size === notes.length
    && NOTE_STATES.every((state) => counts[state] <= MAX_NOTES_BY_STATE[state]);
}

/**
 * The form two note titles are compared in to find a repeated proposal:
 * invisible characters removed, then compatibility-normalised, whitespace
 * collapsed, trimmed and case-folded, so a title with a zero-width or filler
 * character still matches the one it imitates.
 */
export function normalizedInitiativeNoteTitle(title: string): string {
  return title.replace(DEFAULT_IGNORABLE, "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/** Stable note order: creation time, then identity. */
export function compareInitiativeNotes(
  left: Pick<InitiativeNote, "createdAt" | "id">,
  right: Pick<InitiativeNote, "createdAt" | "id">,
): number {
  return compareInitiatives(left, right);
}

/** The first non-blank line of a note body, bounded for the notes index. */
export function initiativeNoteExcerpt(
  body: string,
  maximum = MAX_INITIATIVE_NOTE_INDEX_EXCERPT_CHARS,
): string {
  const line = body.split(/\r\n?|\n/u).map((entry) => entry.trim()).find((entry) => entry !== "") ?? "";
  const characters = [...line.replace(/\s+/gu, " ")];
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, maximum - 1).join("").trimEnd()}…`;
}

/** "1 note", "2 notes": the one count wording shared by labels, receipts and the index. */
export function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function moreNotesLine(count: number): string {
  return `… and ${pluralize(count, "more note")}`;
}

/**
 * The index of accepted notes shared with agents: one `- <title>: <first line>`
 * line per note in creation order, at most 8 KiB. When the index would exceed
 * that, the remaining notes are summarised in a trailing "… and N more notes"
 * line. Returns an empty string when no note is accepted.
 */
export function initiativeNotesIndex(
  notes: readonly Pick<InitiativeNote, "id" | "title" | "body" | "state" | "createdAt">[],
  maximumBytes = MAX_INITIATIVE_NOTES_INDEX_BYTES,
): string {
  const accepted = notes.filter(({ state }) => state === "accepted").sort(compareInitiativeNotes);
  const lines: string[] = [];
  let bytes = 0;
  for (const [index, note] of accepted.entries()) {
    const excerpt = initiativeNoteExcerpt(note.body);
    const line = excerpt ? `- ${note.title}: ${excerpt}` : `- ${note.title}`;
    const lineBytes = utf8ByteLength(line) + (lines.length > 0 ? 1 : 0);
    const remaining = accepted.length - index - 1;
    // Keep room for the summary line whenever notes would still follow.
    const reserve = remaining > 0 ? 1 + utf8ByteLength(moreNotesLine(remaining)) : 0;
    if (bytes + lineBytes + reserve > maximumBytes) {
      const omitted = accepted.length - index;
      const summary = moreNotesLine(omitted);
      if (lines.length === 0 || bytes + 1 + utf8ByteLength(summary) <= maximumBytes) lines.push(summary);
      break;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  return lines.join("\n");
}

/**
 * What one turn shared with its agent. `shared` is a full copy on a fresh
 * session (or the first delivery to this session); `updated` re-sends a part
 * that changed since the copy the session holds; `cleared` tells the agent
 * that its copy of the brief or notes index no longer applies.
 */
export const INITIATIVE_CONTEXT_CHANGES = ["shared", "updated", "cleared"] as const;
export type InitiativeContextChange = typeof INITIATIVE_CONTEXT_CHANGES[number];

export interface InitiativeContextReceipt {
  /** The initiative whose material the turn carried; null when it only announced leaving one. */
  initiativeId: string | null;
  brief: { revision: number; change: InitiativeContextChange } | null;
  notes: { revision: number; count: number; change: InitiativeContextChange } | null;
  /** Set when the turn told the agent that the chat left the initiative it last heard about. */
  left?: true;
  /**
   * Set instead of shared material when the turn's agent proposed a note to
   * its initiative. The note waits for the user's review on the Initiative
   * page; this receipt only records the proposal in the proposing chat.
   */
  proposal?: { noteId: string; kind: InitiativeNoteKind | null };
}

export const MAX_INITIATIVE_CONTEXT_RECEIPT_JSON_BYTES = 512;

const revisionSchema = z.number().int().min(0).max(2_147_483_647);
export const initiativeContextReceiptSchema = z.object({
  initiativeId: z.string().uuid().nullable(),
  brief: z.object({
    revision: revisionSchema,
    change: z.enum(INITIATIVE_CONTEXT_CHANGES),
  }).strict().nullable(),
  notes: z.object({
    revision: revisionSchema,
    count: z.number().int().min(0).max(MAX_INITIATIVE_NOTES),
    change: z.enum(INITIATIVE_CONTEXT_CHANGES),
  }).strict().nullable(),
  left: z.literal(true).optional(),
  proposal: z.object({
    noteId: z.string().uuid(),
    kind: z.enum(INITIATIVE_NOTE_KINDS).nullable(),
  }).strict().optional(),
}).strict().refine(
  ({ brief, notes, left, proposal }) => brief !== null || notes !== null || left === true || proposal !== undefined,
  "An initiative context receipt must describe a brief, notes, leaving an initiative or a proposal.",
).refine(
  ({ initiativeId, brief, notes }) => initiativeId !== null || (brief === null && notes === null),
  "Shared initiative material must name its initiative.",
).refine(
  ({ initiativeId, brief, notes, left, proposal }) => proposal === undefined
    || (initiativeId !== null && brief === null && notes === null && left === undefined),
  "A note proposal receipt names its initiative and nothing else.",
);

export function isInitiativeContextReceipt(value: unknown): value is InitiativeContextReceipt {
  return initiativeContextReceiptSchema.safeParse(value).success;
}


function sharedMaterialText(receipt: Pick<InitiativeContextReceipt, "brief" | "notes">): string | null {
  const { brief, notes } = receipt;
  const sharedBrief = brief && brief.change !== "cleared"
    ? `${brief.change === "updated" ? "the updated" : "the"} initiative brief (revision ${brief.revision})`
    : null;
  const sharedNotes = notes && notes.change !== "cleared"
    ? sharedBrief
      ? pluralize(notes.count, "note")
      : `${pluralize(notes.count, "initiative note")} (revision ${notes.revision})`
    : null;
  const cleared = [
    brief?.change === "cleared" ? `that the initiative brief is now empty (revision ${brief.revision})` : null,
    notes?.change === "cleared" ? `that the initiative has no notes (revision ${notes.revision})` : null,
  ].filter((part): part is string => part !== null);
  const shared = [sharedBrief, sharedNotes].filter((part): part is string => part !== null);
  if (shared.length === 0) return cleared.length === 0 ? null : `Told the agent ${cleared.join(" and ")}.`;
  return `Shared ${shared.join(" and ")} with the agent${cleared.length > 0 ? ` and told it ${cleared.join(" and ")}` : ""}.`;
}

/**
 * The timeline receipt, for example "Shared the initiative brief (revision 3)
 * and 5 notes with the agent." or "Told the agent this chat left the
 * initiative “Checkout”." The same text is persisted as the message body, so
 * the names are those the agent was told at the time.
 */
export function initiativeContextReceiptText(
  receipt: InitiativeContextReceipt,
  names: { left?: string; current?: string } = {},
): string {
  const left = receipt.left
    ? `Told the agent this chat left the initiative “${names.left ?? "unnamed"}”${
      receipt.initiativeId !== null && names.current ? ` and is now part of “${names.current}”` : ""}.`
    : null;
  return [left, sharedMaterialText(receipt)].filter((part): part is string => part !== null).join(" ");
}
