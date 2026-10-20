import { describe, expect, it } from "vitest";

import { PROJECT_COLOR_NAMES } from "../../src/shared/project-colors";
import {
  compareInitiatives,
  defaultInitiativeColor,
  defaultInitiativePreferences,
  INITIATIVE_COLORS,
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_LABELS,
  initiativeAcceptsChats,
  initiativeMembers,
  initiativeNameInputSchema,
  initiativeNameSchema,
  initiativePatchSchema,
  initiativeSchema,
  isInitiativeColor,
  isInitiativeName,
  MAX_INITIATIVE_BRIEF_BYTES,
  MAX_INITIATIVE_NAME_CHARS,
  MAX_INITIATIVES,
  INITIATIVE_BRIEF_CONFLICT_MESSAGE,
  initiativeContextReceiptSchema,
  initiativeContextReceiptText,
  initiativeNoteExcerpt,
  initiativeNoteSchema,
  initiativeNotesIndex,
  initiativeNoteTitleInputSchema,
  isInitiativeContextReceipt,
  MAX_INITIATIVE_NOTE_BODY_BYTES,
  MAX_INITIATIVE_NOTES,
  MAX_INITIATIVE_NOTES_INDEX_BYTES,
  NOTE_PROVENANCES,
  NOTE_STATES,
  utf8ByteLength,
  type InitiativeNote,
  type Initiative,
} from "../../src/shared/initiatives";

const ID = "11111111-1111-4111-8111-111111111111";

function initiative(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: ID,
    name: "Checkout redesign",
    color: "teal",
    status: "active",
    brief: "",
    preferences: defaultInitiativePreferences(), briefRevision: 0, briefUpdatedAt: null, notesRevision: 0, proposedNoteCount: 0,
    revision: 1,
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    ...overrides,
  };
}

describe("initiative contracts", () => {
  it("pins the product limits, statuses and palette", () => {
    expect(MAX_INITIATIVES).toBe(100);
    expect(MAX_INITIATIVE_NAME_CHARS).toBe(120);
    expect(MAX_INITIATIVE_BRIEF_BYTES).toBe(8_192);
    expect(INITIATIVE_STATUSES).toEqual(["active", "done", "archived"]);
    expect(INITIATIVE_STATUSES.map((status) => INITIATIVE_STATUS_LABELS[status]))
      .toEqual(["Active", "Done", "Archived"]);
    expect(INITIATIVE_COLORS).toEqual(PROJECT_COLOR_NAMES);
  });

  it("trims typed names and rejects empty, multi-line, tabbed, NUL and overlong names", () => {
    expect(initiativeNameInputSchema.parse("  Release 1.0  ")).toBe("Release 1.0");
    expect(initiativeNameInputSchema.parse("\tRelease\u00a0")).toBe("Release");
    expect(initiativeNameInputSchema.parse("x".repeat(120))).toHaveLength(120);
    for (const invalid of ["", "   ", "x".repeat(121), "Two\nlines", "Carriage\rreturn", "nul\0", "Tab\tinside"]) {
      expect(initiativeNameInputSchema.safeParse(invalid).success).toBe(false);
    }
    expect(isInitiativeName("Release")).toBe(true);
    expect(isInitiativeName(" Release ")).toBe(false);
    expect(isInitiativeName(42)).toBe(false);
  });

  it("validates stored names exactly like the SQL CHECK, counting characters", () => {
    // SQLite trim() strips only spaces and length() counts characters.
    expect(initiativeNameSchema.safeParse("\u00a0").success).toBe(true);
    expect(initiativeNameSchema.safeParse("😀".repeat(120)).success).toBe(true);
    expect(initiativeNameSchema.safeParse("😀".repeat(121)).success).toBe(false);
    for (const invalid of [" Leading", "Trailing ", "", "Tab\tinside", "Line\nbreak", "nul\0"]) {
      expect(initiativeNameSchema.safeParse(invalid).success).toBe(false);
    }
    // Stored names are validated, never rewritten.
    expect(initiativeNameSchema.parse("Release")).toBe("Release");
  });

  it("accepts only palette colour names", () => {
    for (const color of PROJECT_COLOR_NAMES) expect(isInitiativeColor(color)).toBe(true);
    for (const invalid of ["#ff0000", "magenta", "", null, 3]) expect(isInitiativeColor(invalid)).toBe(false);
  });

  it("rotates default colours through the palette", () => {
    expect(defaultInitiativeColor(0)).toBe(PROJECT_COLOR_NAMES[0]);
    expect(defaultInitiativeColor(1)).toBe(PROJECT_COLOR_NAMES[1]);
    expect(defaultInitiativeColor(PROJECT_COLOR_NAMES.length)).toBe(PROJECT_COLOR_NAMES[0]);
    expect(defaultInitiativeColor(-3)).toBe(PROJECT_COLOR_NAMES[0]);
    expect(defaultInitiativeColor(Number.NaN)).toBe(PROJECT_COLOR_NAMES[0]);
  });

  it("validates complete initiatives strictly", () => {
    expect(initiativeSchema.parse(initiative())).toEqual(initiative());
    expect(initiativeSchema.parse(initiative({ brief: "😀".repeat(2_048), revision: 0 })))
      .toMatchObject({ revision: 0 });
    for (const invalid of [
      initiative({ id: "not-a-uuid" }),
      initiative({ color: "#00ff00" as never }),
      initiative({ status: "paused" as never }),
      initiative({ brief: "b".repeat(8_193) }),
      // The brief counts UTF-8 bytes: 2,049 four-byte characters are 8,196 bytes.
      initiative({ brief: "😀".repeat(2_049) }),
      initiative({ brief: "nul\0" }),
      initiative({ briefRevision: -1 }),
      initiative({ revision: -1 }),
      initiative({ createdAt: "yesterday" }),
      { ...initiative(), preferences: { ...defaultInitiativePreferences(), skillsFolder: "yes" } },
    ]) {
      expect(initiativeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires every patch to change something known", () => {
    expect(initiativePatchSchema.parse({ status: "done" })).toEqual({ status: "done" });
    for (const invalid of [{}, { name: "" }, { color: "magenta" }, { status: "paused" }, { brief: "Later" }]) {
      expect(initiativePatchSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("orders by creation time, then identity, and lets only active initiatives take chats", () => {
    const later = initiative({ id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-19T11:00:00.000Z" });
    const sameTime = initiative({ id: "00000000-0000-4000-8000-000000000000" });
    expect([later, initiative(), sameTime].sort(compareInitiatives).map(({ id }) => id))
      .toEqual([sameTime.id, ID, later.id]);
    expect(initiativeAcceptsChats({ status: "active" })).toBe(true);
    expect(initiativeAcceptsChats({ status: "done" })).toBe(false);
    expect(initiativeAcceptsChats({ status: "archived" })).toBe(false);
  });

  it("groups members by initiative in input order and skips chats without one", () => {
    const chats = [
      { id: "a", initiativeId: "one" },
      { id: "b", initiativeId: null },
      { id: "c", initiativeId: "two" },
      { id: "d", initiativeId: "one" },
      { id: "e" },
    ];
    const members = initiativeMembers(chats, ({ initiativeId }: { initiativeId?: string | null }) => initiativeId);
    expect([...members.keys()]).toEqual(["one", "two"]);
    expect(members.get("one")?.map(({ id }) => id)).toEqual(["a", "d"]);
    expect(members.get("two")?.map(({ id }) => id)).toEqual(["c"]);
  });
});

function note(index: number, overrides: Partial<InitiativeNote> = {}): InitiativeNote {
  const at = new Date(Date.UTC(2026, 9, 19, 10, 0, index)).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    initiativeId: ID,
    title: `Note ${index}`,
    body: `Body ${index}`,
    provenance: "user",
    state: "accepted",
    sourceConversationId: null,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("initiative notes contracts", () => {
  it("pins the note limits, provenances and states", () => {
    expect(MAX_INITIATIVE_NOTES).toBe(64);
    expect(MAX_INITIATIVE_NOTE_BODY_BYTES).toBe(2_048);
    expect(MAX_INITIATIVE_NOTES_INDEX_BYTES).toBe(8_192);
    expect(NOTE_PROVENANCES).toEqual(["user", "agent"]);
    expect(NOTE_STATES).toEqual(["proposed", "accepted", "rejected"]);
    expect(INITIATIVE_BRIEF_CONFLICT_MESSAGE).toBe("The brief changed elsewhere. Reload to see the latest.");
  });

  it("validates titles like names and bodies in UTF-8 bytes, allowing an empty body", () => {
    expect(initiativeNoteTitleInputSchema.parse("  Decision  ")).toBe("Decision");
    for (const invalid of ["", " ", "x".repeat(121), "Two\nlines", "Tab\there", "nul\0"]) {
      expect(initiativeNoteTitleInputSchema.safeParse(invalid).success).toBe(false);
    }
    expect(initiativeNoteSchema.parse(note(1, { body: "" }))).toMatchObject({ body: "" });
    // 512 four-byte characters are exactly 2,048 bytes.
    expect(initiativeNoteSchema.safeParse(note(1, { body: "😀".repeat(512) })).success).toBe(true);
    expect(initiativeNoteSchema.safeParse(note(1, { body: `${"😀".repeat(512)}x` })).success).toBe(false);
    expect(initiativeNoteSchema.safeParse(note(1, { body: "a\0b" })).success).toBe(false);
    expect(initiativeNoteSchema.safeParse(note(1, { provenance: "system" as never })).success).toBe(false);
    expect(initiativeNoteSchema.safeParse(note(1, { state: "pending" as never })).success).toBe(false);
    expect(initiativeNoteSchema.safeParse({ ...note(1), extra: true }).success).toBe(false);
  });

  it("indexes accepted notes in creation order as one bounded line each", () => {
    const notes = [
      note(3, { title: "Third", body: "\n\n  Last decided  \nsecond line" }),
      note(1, { title: "First", body: "Use Postgres." }),
      note(2, { title: "Proposed", state: "proposed" }),
      note(4, { title: "Rejected", state: "rejected" }),
      note(5, { title: "Bare", body: "" }),
    ];
    expect(initiativeNotesIndex(notes)).toBe([
      "- First: Use Postgres.",
      "- Third: Last decided",
      "- Bare",
    ].join("\n"));
    expect(initiativeNotesIndex([note(1, { state: "proposed" })])).toBe("");
    expect(initiativeNoteExcerpt(`${"y".repeat(200)}\nrest`)).toBe(`${"y".repeat(159)}…`);
    expect([...initiativeNoteExcerpt("😀".repeat(200))]).toHaveLength(160);
  });

  it("cuts the index at 8 KiB with a trailing count of the notes left out", () => {
    const notes = Array.from({ length: 64 }, (_, index) => note(index, {
      title: `${"T".repeat(100)} ${index}`,
      body: "B".repeat(400),
    }));
    const index = initiativeNotesIndex(notes);
    expect(utf8ByteLength(index)).toBeLessThanOrEqual(MAX_INITIATIVE_NOTES_INDEX_BYTES);
    const lines = index.split("\n");
    const shown = lines.length - 1;
    expect(lines.at(-1)).toBe(`… and ${64 - shown} more notes`);
    expect(lines.slice(0, -1).every((line, position) => line.startsWith(`- ${"T".repeat(100)} ${position}: `))).toBe(true);
    // Deterministic for the same notes in any input order.
    expect(initiativeNotesIndex([...notes].reverse())).toBe(index);
    // A one-note overflow reads naturally, and a last note that fits where
    // its summary would go is shown instead.
    const budget = utf8ByteLength("- Note 1: Body 1") + 1 + utf8ByteLength("… and 1 more note");
    expect(initiativeNotesIndex([note(1), note(2, { title: "A longer second note" })], budget))
      .toBe("- Note 1: Body 1\n… and 1 more note");
    expect(initiativeNotesIndex([note(1), note(2)], budget)).toBe("- Note 1: Body 1\n- Note 2: Body 2");
  });

  it("describes what a turn shared in one receipt sentence", () => {
    const receipt = (brief: InitiativeContextReceiptBrief, notes: InitiativeContextReceiptNotes) =>
      initiativeContextReceiptText({ initiativeId: ID, brief, notes });
    expect(receipt({ revision: 3, change: "shared" }, { revision: 1, count: 5, change: "shared" }))
      .toBe("Shared the initiative brief (revision 3) and 5 notes with the agent.");
    expect(receipt({ revision: 4, change: "updated" }, null))
      .toBe("Shared the updated initiative brief (revision 4) with the agent.");
    expect(receipt(null, { revision: 2, count: 6, change: "updated" }))
      .toBe("Shared 6 initiative notes (revision 2) with the agent.");
    expect(receipt(null, { revision: 2, count: 1, change: "shared" }))
      .toBe("Shared 1 initiative note (revision 2) with the agent.");
    expect(receipt({ revision: 5, change: "cleared" }, null))
      .toBe("Told the agent that the initiative brief is now empty (revision 5).");
    expect(receipt({ revision: 5, change: "updated" }, { revision: 3, count: 0, change: "cleared" }))
      .toBe("Shared the updated initiative brief (revision 5) with the agent and told it that the initiative has no notes (revision 3).");
    expect(initiativeContextReceiptText({ initiativeId: null, brief: null, notes: null, left: true }, { left: "Checkout" }))
      .toBe("Told the agent this chat left the initiative “Checkout”.");
    expect(initiativeContextReceiptText(
      { initiativeId: ID, brief: { revision: 1, change: "shared" }, notes: null, left: true },
      { left: "Checkout", current: "Payments" },
    )).toBe("Told the agent this chat left the initiative “Checkout” and is now part of “Payments”. Shared the initiative brief (revision 1) with the agent.");
  });

  it("accepts only a well-formed receipt that names at least one part", () => {
    const valid = {
      initiativeId: ID,
      brief: { revision: 2, change: "shared" },
      notes: null,
    };
    expect(isInitiativeContextReceipt(valid)).toBe(true);
    expect(utf8ByteLength(JSON.stringify({
      ...valid,
      notes: { revision: 2_147_483_647, count: 64, change: "updated" },
    }))).toBeLessThanOrEqual(512);
    expect(isInitiativeContextReceipt({ initiativeId: null, brief: null, notes: null, left: true })).toBe(true);
    expect(isInitiativeContextReceipt({ ...valid, brief: null, left: true })).toBe(true);
    for (const invalid of [
      { ...valid, brief: null },
      // Shared material always names its initiative.
      { ...valid, initiativeId: null },
      { ...valid, left: false },
      { ...valid, initiativeId: "short" },
      { ...valid, brief: { revision: -1, change: "shared" } },
      { ...valid, brief: { revision: 1, change: "replaced" } },
      { ...valid, notes: { revision: 1, count: 65, change: "shared" } },
      { ...valid, extra: true },
    ]) {
      expect(initiativeContextReceiptSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

type InitiativeContextReceiptBrief = Parameters<typeof initiativeContextReceiptText>[0]["brief"];
type InitiativeContextReceiptNotes = Parameters<typeof initiativeContextReceiptText>[0]["notes"];
